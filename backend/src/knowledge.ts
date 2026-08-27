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
  env?: string | null; via?: 'fulltext' | 'hybrid';
};

type ScoredHit = KnowledgeHit & { _raw: number; _vec?: number[] | null; _model?: string | null };

const clip = (s: any, n = 280) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Weight on the keyword term when a comparable vector exists. The remainder is the
// cosine term; with no vector the cosine term falls back to the keyword score, which
// leaves un-embedded rows exactly where FULLTEXT put them.
const FT_WEIGHT = 0.6;

/** Search the knowledge base. Optional symbol filter scopes to one ticker; `env`
 *  defaults to the active trading account (pass null for shared knowledge only). */
export async function searchKnowledge(
  query: string,
  opts: { symbol?: string; limit?: number; env?: string | null } = {},
): Promise<KnowledgeHit[]> {
  const term = String(query || '').trim();
  if (!term) return [];
  const limit = Math.min(opts.limit ?? 20, 50);
  const sym = opts.symbol ? opts.symbol.toUpperCase() : null;
  const env = opts.env !== undefined ? opts.env : await getTradingEnv();
  const symFilter = (col: string) => (sym ? ` AND ${col}=:sym` : '');
  const envFilter = ' AND (env IS NULL OR env=:env)';
  const params: any = { q: term, sym, lim: limit, env };

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
    (r) => ({ source: 'news', id: r.id, symbol: r.symbol, title: clip(r.headline, 140), snippet: clip(r.summary || r.headline), score: Number(r.score), _raw: Number(r.score), created_at: r.published_at, url: r.url, env: null }),
  );
  await run(
    `SELECT id, symbol, title, analysis, updated_at,
            MATCH(analysis) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM research_notes WHERE MATCH(analysis) AGAINST (:q IN NATURAL LANGUAGE MODE)${symFilter('symbol')}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'research', id: r.id, symbol: r.symbol, title: clip(r.title, 140), snippet: clip(r.analysis), score: Number(r.score), _raw: Number(r.score), created_at: r.updated_at, env: null }),
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
            metadata->>'$.title' title, metadata->>'$.symbol' symbol,
            MATCH(doc_text) AGAINST (:q IN NATURAL LANGUAGE MODE) score
     FROM rag_documents WHERE MATCH(doc_text) AGAINST (:q IN NATURAL LANGUAGE MODE)${envFilter}${sym ? " AND metadata->>'$.symbol'=:sym" : ''}
     ORDER BY score DESC LIMIT :lim`,
    (r) => ({ source: 'rag', id: r.id, symbol: r.symbol ?? null, title: clip(r.title || r.doc_text, 140), snippet: clip(r.doc_text), score: Number(r.score), _raw: Number(r.score), created_at: r.created_at, env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
  );

  // Fallback to LIKE if FULLTEXT found nothing (e.g. very short/stopword query).
  if (!hits.length) {
    const like = `%${term.replace(/[%_]/g, '')}%`;
    try {
      const rows = await q<any>(
        `SELECT id, symbol, headline, summary, published_at FROM news
         WHERE (headline LIKE :like OR summary LIKE :like)${sym ? ' AND symbol=:sym' : ''}
         ORDER BY published_at DESC LIMIT :lim`,
        { like, sym, lim: limit },
      );
      rows.forEach((r) => hits.push({ source: 'news', id: r.id, symbol: r.symbol, title: clip(r.headline, 140), snippet: clip(r.summary || r.headline), score: 0.1, _raw: 0.1, created_at: r.published_at, env: null }));
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
      `SELECT id, doc_text, env, embedding, embed_model, created_at, metadata->>'$.title' title, metadata->>'$.symbol' symbol
       FROM rag_documents WHERE embed_model=:m${envFilter}${sym ? " AND metadata->>'$.symbol'=:sym" : ''} ORDER BY created_at DESC LIMIT 300`,
      (r) => ({ source: 'rag', id: r.id, symbol: r.symbol ?? null, title: clip(r.title || r.doc_text, 140), snippet: clip(r.doc_text), score: 0, _raw: 0, created_at: r.created_at, env: r.env ?? null, _vec: parseVector(r.embedding), _model: r.embed_model ?? null }),
    );
  }
  if (!hits.length) return [];

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

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ _raw, _vec, _model, ...hit }) => hit);
}

/** Compact context string for feeding retrieved knowledge into an LLM prompt. */
export function knowledgeToContext(hits: KnowledgeHit[]): string {
  return hits.slice(0, 12).map((h, i) => `[${i + 1}] (${h.source}${h.symbol ? ' · ' + h.symbol : ''}) ${h.title}: ${h.snippet}`).join('\n');
}
