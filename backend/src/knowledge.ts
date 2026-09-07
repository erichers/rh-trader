import { q, getTradingEnv } from './db.js';
import { config } from './config.js';
import { embedTexts } from './ai/embed.js';
import { cosine, parseVector } from './rag.js';

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge / RAG retrieval. A unified search across everything the app has learned
// — news, research notes, learnings, per-ticker AI insights and RAG documents — so
// the chat agent and the UI can pull real, stored context on demand.
//
// ACCOUNT SCOPED: learnings, insights and RAG docs carry an `env`. A search returns
// the shared market knowledge (env IS NULL) plus whatever THIS account learned, never
// another account's trade history.
//
// HYBRID RANK: FULLTEXT relevance normalized to 0..1, blended with cosine similarity
// against the query embedding for rows that carry a vector from the SAME model. Rows
// without a vector keep their keyword rank (the semantic term falls back to it), so
// nothing drops out of the results while embeddings are dormant. Falls back to LIKE
// when a FULLTEXT query yields nothing (short tokens / stopwords).
// ─────────────────────────────────────────────────────────────────────────────

export type KnowledgeHit = {
  source: 'news' | 'research' | 'learning' | 'insight' | 'rag';
  id: number; symbol: string | null; title: string; snippet: string;
  score: number; created_at: any; url?: string | null;
  env?: string | null; via?: 'fulltext' | 'hybrid' | 'recent';
};

type ScoredHit = KnowledgeHit & { _raw: number; _vec?: number[] | null; _model?: string | null };

const clip = (s: any, n = 280) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** First real http(s) URL in a string or JSON blob. Never invents a link. */
function firstHttps(v: any): string | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
  const m = s.match(/https?:\/\/[^\s"'<>\\]+/i);
  if (!m) return null;
  return m[0].replace(/[),.;]+$/g, '').slice(0, 500);
}

function recencyBoost(createdAt: any): number {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  if (days < 1) return 0.14;
  if (days < 7) return 0.09;
  if (days < 30) return 0.04;
  return 0;
}

let extraChunkTable: string | null | undefined;
async function optionalChunkTable(): Promise<string | null> {
  if (extraChunkTable !== undefined) return extraChunkTable;
  try {
    const rows = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=DATABASE() AND table_name IN ('ulric_rag_chunks','rag_chunks')
       ORDER BY table_name='ulric_rag_chunks' DESC LIMIT 1`,
    );
    extraChunkTable = rows[0]?.table_name || null;
  } catch {
    extraChunkTable = null;
  }
  return extraChunkTable;
}

async function chunkColumns(table: string): Promise<Record<string, string>> {
  const rows = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=:t`,
    { t: table },
  );
  const have = new Set(rows.map((r) => String(r.column_name).toLowerCase()));
  const pick = (...cands: string[]) => cands.find((c) => have.has(c)) || '';
  return {
    id: pick('id'),
    text: pick('chunk_text', 'content', 'body', 'text', 'doc_text', 'chunk'),
    title: pick('title', 'headline'),
    url: pick('url', 'source_url', 'link'),
    symbol: pick('symbol', 'ticker'),
    created: pick('created_at', 'updated_at', 'published_at'),
  };
}

// Weight on the keyword term when a comparable vector exists. The remainder is the
// cosine term; with no vector the cosine term falls back to the keyword score, which
// leaves un-embedded rows exactly where FULLTEXT put them.
const FT_WEIGHT = 0.6;

/** Search the knowledge base. Optional symbol filter scopes to one ticker; `env`
 *  defaults to the active trading account (pass null for shared knowledge only). */
export async function searchKnowledge(
  query: string,
  opts: { symbol?: string; limit?: number; env?: string | null; preferRecent?: boolean } = {},
): Promise<KnowledgeHit[]> {
  const term = String(query || '').trim();
  if (!term) return [];
  const limit = Math.min(opts.limit ?? 24, 60);
  const fetchLim = Math.min(30, Math.max(limit, 16));
  const sym = opts.symbol ? opts.symbol.toUpperCase() : null;
  const env = opts.env !== undefined ? opts.env : await getTradingEnv();
  const symFilter = (col: string) => (sym ? ` AND ${col}=:sym` : '');
  const envFilter = ' AND (env IS NULL OR env=:env)';
  const params: any = { q: term, sym, lim: fetchLim, env };

  const hits: ScoredHit[] = [];
  // Each block is best-effort: a malformed FULLTEXT term shouldn't kill the search.
  const run = async (sql: string, map: (r: any) => ScoredHit) => {
    try {
      const rows = await q<any>(sql, params);
      if (process.env.KNOWLEDGE_DEBUG) console.error(`[knowledge] block ${sql.trim().slice(0, 40).replace(/\s+/g, ' ')} -> ${rows.length} rows`);
      rows.forEach((r) => hits.push(map(r)));
    }
    catch (e: any) { console.error(`[knowledge] search block failed: ${String(e?.message || e).slice(0, 200)}`); }
  };

  await run(
    `SELECT id, symbol, headline, summary, source, url, published_at,
            MATCH(headline,summary) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM news WHERE MATCH(headline,summary) AGAINST (:q IN NATURAL LANGUAGE MODE)${symFilter('symbol')}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'news', id: r.id, symbol: r.symbol, title: clip(r.headline, 140), snippet: clip(r.summary || r.headline), score: Number(r.score), _raw: Number(r.score), created_at: r.published_at, url: firstHttps(r.url), env: null }),
  );
  await run(
    `SELECT id, symbol, title, analysis, sources, updated_at,
            MATCH(analysis) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM research_notes WHERE MATCH(analysis) AGAINST (:q IN NATURAL LANGUAGE MODE)${symFilter('symbol')}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'research', id: r.id, symbol: r.symbol, title: clip(r.title, 140), snippet: clip(r.analysis), score: Number(r.score), _raw: Number(r.score), created_at: r.updated_at, url: firstHttps(r.sources), env: null }),
  );
  await run(
    `SELECT id, title, body, env, embedding, embed_model, created_at,
            MATCH(title,body) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM learnings WHERE MATCH(title,body) AGAINST (:q IN NATURAL LANGUAGE MODE)${envFilter}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'learning', id: r.id, symbol: null, title: clip(r.title, 140), snippet: clip(r.body), score: Number(r.score), _raw: Number(r.score), created_at: r.created_at, env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
  );
  await run(
    `SELECT id, symbol, summary, lesson, env, created_at,
            MATCH(summary,lesson) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM ticker_insights WHERE MATCH(summary,lesson) AGAINST (:q IN NATURAL LANGUAGE MODE)${envFilter}${symFilter('symbol')}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'insight', id: r.id, symbol: r.symbol, title: `${r.symbol} insight`, snippet: clip(r.lesson || r.summary), score: Number(r.score), _raw: Number(r.score), created_at: r.created_at, env: r.env ?? null }),
  );
  await run(
    `SELECT id, doc_text, env, embedding, embed_model, created_at,
            metadata->>'$.title' title, metadata->>'$.symbol' symbol, metadata->>'$.url' url,
            MATCH(doc_text) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM rag_documents WHERE MATCH(doc_text) AGAINST (:q IN NATURAL LANGUAGE MODE)${envFilter}${sym ? " AND metadata->>'$.symbol'=:sym" : ''}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'rag', id: r.id, symbol: r.symbol ?? null, title: clip(r.title || r.doc_text, 140), snippet: clip(r.doc_text), score: Number(r.score), _raw: Number(r.score), created_at: r.created_at, url: firstHttps(r.url), env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
  );

  const extra = await optionalChunkTable();
  if (extra) {
    try {
      const cols = await chunkColumns(extra);
      if (cols.text && cols.id) {
        const like = `%${term.replace(/[%_]/g, '')}%`;
        const titleExpr = cols.title ? cols.title : `LEFT(${cols.text}, 140)`;
        const urlExpr = cols.url ? cols.url : 'NULL';
        const symExpr = cols.symbol ? cols.symbol : 'NULL';
        const createdExpr = cols.created ? cols.created : 'NULL';
        const symClause = sym && cols.symbol ? ` AND ${cols.symbol}=:sym` : '';
        const rows = await q<any>(
          `SELECT ${cols.id} id, ${titleExpr} title, ${cols.text} body, ${urlExpr} url, ${symExpr} symbol, ${createdExpr} created_at
           FROM ${extra}
           WHERE (${cols.text} LIKE :like${cols.title ? ` OR ${cols.title} LIKE :like` : ''})${symClause}
           ORDER BY ${cols.created || cols.id} DESC LIMIT :lim`,
          { like, sym, lim: fetchLim },
        );
        rows.forEach((r) => hits.push({
          source: 'rag', id: Number(r.id), symbol: r.symbol ?? null, title: clip(r.title || r.body, 140),
          snippet: clip(r.body), score: 0.12, _raw: 0.12, created_at: r.created_at, url: firstHttps(r.url), env: null,
        }));
      }
    } catch (e: any) {
      console.error(`[knowledge] optional ${extra} failed: ${String(e?.message || e).slice(0, 160)}`);
    }
  }

  // Fallback to LIKE if FULLTEXT found nothing (e.g. very short/stopword query).
  if (!hits.length) {
    const like = `%${term.replace(/[%_]/g, '')}%`;
    try {
      const rows = await q<any>(
        `SELECT id, symbol, headline, summary, url, published_at FROM news
         WHERE (headline LIKE :like OR summary LIKE :like)${sym ? ' AND symbol=:sym' : ''}
         ORDER BY published_at DESC LIMIT :lim`,
        { like, sym, lim: fetchLim },
      );
      rows.forEach((r) => hits.push({ source: 'news', id: r.id, symbol: r.symbol, title: clip(r.headline, 140), snippet: clip(r.summary || r.headline), score: 0.1, _raw: 0.1, created_at: r.published_at, url: firstHttps(r.url), env: null }));
    } catch { /* skip */ }
  }
  // Query embedding (only when NIM is configured), bounded to ~2.5s so a slow provider can
  // never stall a user-facing search: on timeout we simply fall back to keywords. (CP3 gate)
  let qvec: number[] | null = null;
  let qmodel = '';
  if (config.nvidia.apiKey) {
    const emb = await Promise.race([
      embedTexts([term], 'query').catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (emb?.vectors?.length) { qvec = emb.vectors[0]; qmodel = emb.model; }
  }

  // Vector-candidate pass: embedded rows that share NO keyword with the query are still
  // reachable by meaning (re-ranking fulltext hits alone can never find them). Recent
  // rows of the two embedded tables, same env scope, same embedding model.
  if (qvec) {
    const seen = new Set(hits.map((h) => `${h.source}:${h.id}`));
    const vparams = { ...params, m: qmodel };
    const vrun = async (sql: string, map: (r: any) => ScoredHit) => {
      try {
        for (const r of await q<any>(sql, vparams)) {
          const h = map(r);
          if (seen.has(`${h.source}:${h.id}`)) continue;
          const c = cosine(qvec, h._vec ?? null);
          if (c == null) continue;
          (h as any)._cos = c;
          seen.add(`${h.source}:${h.id}`);
          hits.push(h);
        }
      } catch (e: any) { console.error(`[knowledge] vector block failed: ${String(e?.message || e).slice(0, 200)}`); }
    };
    await vrun(
      `SELECT id, title, body, env, embedding, embed_model, created_at FROM learnings
       WHERE embed_model=:m${envFilter} ORDER BY created_at DESC LIMIT 300`,
      (r) => ({ source: 'learning', id: r.id, symbol: null, title: clip(r.title, 140), snippet: clip(r.body), score: 0, _raw: 0, created_at: r.created_at, env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
    );
    await vrun(
      `SELECT id, doc_text, env, embedding, embed_model, created_at, metadata->>'$.title' title, metadata->>'$.symbol' symbol, metadata->>'$.url' url
       FROM rag_documents WHERE embed_model=:m${envFilter}${sym ? " AND metadata->>'$.symbol'=:sym" : ''} ORDER BY created_at DESC LIMIT 300`,
      (r) => ({ source: 'rag', id: r.id, symbol: r.symbol ?? null, title: clip(r.title || r.doc_text, 140), snippet: clip(r.doc_text), score: 0, _raw: 0, created_at: r.created_at, url: firstHttps(r.url), env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
    );
  }
  // Empty keyword/vector set is OK when preferRecent can still fill from the desk.

  // Blend. Keyword relevance is normalized to the best hit; cosine is floor-normalized
  // (NIM similarity rarely drops below ~0.5 even for unrelated text) so an embedded row
  // cannot outrank real news/research on a vague resemblance alone. (CP3 gate)
  // Reciprocal rank fusion (ship-day fix, replaces score blending): FULLTEXT scores are not
  // comparable across tables and cosine scales differ per embedding model, so ranks are
  // fused instead of scores. score = 1/(k+kwRank) + 1/(k+vecRank), k=60. A row present in
  // both lists (a real keyword AND semantic match) naturally rises to the top; embedded
  // rows with no keyword overlap still enter via their vector rank.
  const K = 60;
  const kwRanked = hits.filter((h) => (h._raw || 0) > 0).sort((a, b) => (b._raw || 0) - (a._raw || 0));
  const kwRank = new Map<ScoredHit, number>(); kwRanked.forEach((h, idx) => kwRank.set(h, idx + 1));
  const withCos = qvec ? hits.map((h) => ({ h, c: (h as any)._cos ?? (h._model === qmodel ? cosine(qvec, h._vec ?? null) : null) })).filter((x) => x.c != null) : [];
  withCos.sort((a, b) => (b.c as number) - (a.c as number));
  const maxCos = withCos.length ? (withCos[0].c as number) : 0;
  const vecRank = new Map<ScoredHit, number>();
  // Relative gate (scale-free): only rows within 0.15 of the best cosine count as semantic matches.
  withCos.filter((x) => (x.c as number) >= maxCos - 0.15).forEach((x, idx) => vecRank.set(x.h, idx + 1));
  for (const h of hits) {
    const kr = kwRank.get(h); const vr = vecRank.get(h);
    h.via = vr != null ? 'hybrid' : 'fulltext';
    h.score = Number((((kr != null ? 1 / (K + kr) : 0) + (vr != null ? 1 / (K + vr) : 0)) * 100).toFixed(4));
  }

  if (opts.preferRecent) {
    const seen = new Set(hits.map((h) => `${h.source}:${h.id}`));
    const addRecent = async (sql: string, map: (r: any) => ScoredHit) => {
      try {
        for (const r of await q<any>(sql, { sym, env, lim: 8 })) {
          const h = map(r);
          const key = `${h.source}:${h.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          h.via = 'recent';
          hits.push(h);
        }
      } catch (e: any) {
        console.error(`[knowledge] recent block failed: ${String(e?.message || e).slice(0, 160)}`);
      }
    };
    await addRecent(
      `SELECT id, symbol, headline, summary, url, published_at FROM news
       WHERE 1=1${symFilter('symbol')} ORDER BY published_at DESC LIMIT :lim`,
      (r) => ({ source: 'news', id: r.id, symbol: r.symbol, title: clip(r.headline, 140), snippet: clip(r.summary || r.headline), score: 0.06, _raw: 0.06, created_at: r.published_at, url: firstHttps(r.url), env: null }),
    );
    await addRecent(
      `SELECT id, title, body, env, created_at FROM learnings
       WHERE 1=1${envFilter} ORDER BY created_at DESC LIMIT :lim`,
      (r) => ({ source: 'learning', id: r.id, symbol: null, title: clip(r.title, 140), snippet: clip(r.body), score: 0.06, _raw: 0.06, created_at: r.created_at, env: r.env ?? null }),
    );
    await addRecent(
      `SELECT id, symbol, title, analysis, sources, updated_at FROM research_notes
       WHERE 1=1${symFilter('symbol')} ORDER BY updated_at DESC LIMIT :lim`,
      (r) => ({ source: 'research', id: r.id, symbol: r.symbol, title: clip(r.title, 140), snippet: clip(r.analysis), score: 0.06, _raw: 0.06, created_at: r.updated_at, url: firstHttps(r.sources), env: null }),
    );
    await addRecent(
      `SELECT id, doc_text, env, created_at, metadata->>'$.title' title, metadata->>'$.symbol' symbol, metadata->>'$.url' url
       FROM rag_documents WHERE 1=1${envFilter}${sym ? " AND metadata->>'$.symbol'=:sym" : ''}
       ORDER BY created_at DESC LIMIT :lim`,
      (r) => ({ source: 'rag', id: r.id, symbol: r.symbol ?? null, title: clip(r.title || r.doc_text, 140), snippet: clip(r.doc_text), score: 0.05, _raw: 0.05, created_at: r.created_at, url: firstHttps(r.url), env: r.env ?? null }),
    );
  }

  for (const h of hits) {
    const boost = recencyBoost(h.created_at);
    if (boost) h.score = Number((h.score * (1 + boost) + boost).toFixed(4));
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ _raw, _vec, _model, ...hit }) => hit);
}

/** Compact context string for feeding retrieved knowledge into an LLM prompt. */
export function knowledgeToContext(hits: KnowledgeHit[]): string {
  return hits.slice(0, 16).map((h, i) => {
    const url = h.url ? ` · ${h.url}` : '';
    return `[${i + 1}] (${h.source}${h.symbol ? ' · ' + h.symbol : ''}${url}) ${h.title}: ${h.snippet}`;
  }).join('\n');
}
