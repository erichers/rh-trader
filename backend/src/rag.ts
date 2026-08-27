import { q, exec, audit, getTradingEnv } from './db.js';
import { config } from './config.js';
import { embedTexts } from './ai/embed.js';
import { EMBED_LADDER } from './ai/models.js';

// ─────────────────────────────────────────────────────────────────────────────
// RAG write path + embedding backfill.
//
// Every learning and every RAG document goes in through addLearning/addRagDocument
// so the `env` tag (WHICH ACCOUNT the lesson came from) can never be forgotten at a
// call site: env = null means shared market knowledge (news, macro, research), env =
// 'alpaca_paper' | 'robinhood_live' means it was derived from that account's own
// trades, signals, orders, monitors or bots.
//
// Embeddings are optional. With no NVIDIA_API_KEY the corpus still works on FULLTEXT
// alone (embedPending returns {dormant:true} and touches no rows). Each embedded row
// stores the model that produced its vector, because vectors from different models are
// incomparable: a row whose model is not the current one is re-embedded, never mixed.
// ─────────────────────────────────────────────────────────────────────────────

/** The embedding model rows should currently carry (env override wins if it is a real id). */
export function currentEmbedModel(): string {
  return config.nvidia.model && EMBED_LADDER.includes(config.nvidia.model) ? config.nvidia.model : EMBED_LADDER[0];
}

export function embeddingsDormant(): boolean {
  return !config.nvidia.apiKey;
}

/** mysql2 hands JSON columns back as a parsed array OR as a raw string. Normalize. */
export function parseVector(v: any): number[] | null {
  if (v == null) return null;
  let a: any = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  if (!Array.isArray(a) || !a.length) return null;
  const out = a.map((x) => Number(x));
  return out.every((x) => Number.isFinite(x)) ? out : null;
}

/** Cosine similarity in [-1,1]. null when the vectors are missing or not comparable. */
export function cosine(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0 || nb <= 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const clip = (s: any, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── write path ──────────────────────────────────────────────────────────────

export type LearningInput = {
  kind?: string;          // post_trade|lesson|ticker_lesson|daily_review|note|playbook
  type?: string;          // alias for kind (callers that speak in "type")
  title: string;
  body: string;
  env: string | null;     // REQUIRED decision: null = shared, else the account it was learned on
  symbol?: string | null;
  data?: any;
  tags?: string[];
};

/** Single write path for learnings. Symbol lands in data + tags (the table has no
 *  symbol column) so the existing FULLTEXT/UI reads keep working unchanged. */
export async function addLearning(a: LearningInput): Promise<number> {
  const kind = clip(a.kind || a.type || 'note', 32);
  const symbol = a.symbol ? String(a.symbol).toUpperCase().slice(0, 12) : null;
  const data = { ...(a.data || {}), ...(symbol ? { symbol } : {}) };
  const tags = Array.from(new Set([...(a.tags || []), ...(symbol ? [symbol] : [])].map((t) => String(t).slice(0, 32))));
  const res = await exec(
    `INSERT INTO learnings (kind, title, body, data, tags, env)
     VALUES (:kind,:title,:body,CAST(:data AS JSON),CAST(:tags AS JSON),:env)`,
    { kind, title: clip(a.title, 250), body: String(a.body ?? ''), data: JSON.stringify(data), tags: JSON.stringify(tags), env: a.env ?? null },
  );
  return res.insertId;
}

export type RagDocInput = {
  kind: string;           // what produced it: trade_journal|daily_review|research|idea|note
  body: string;
  env: string | null;     // REQUIRED decision: null = shared market knowledge
  title?: string;
  symbol?: string | null;
  source?: string | null; // model/provider or subsystem that wrote it
  sourceId?: number | null;
  meta?: Record<string, any>;
};

/** Single write path for RAG documents. rag_documents has no symbol/title/source columns,
 *  so those live in metadata (and in doc_text, which is what FULLTEXT actually searches). */
export async function addRagDocument(d: RagDocInput): Promise<number> {
  const symbol = d.symbol ? String(d.symbol).toUpperCase().slice(0, 12) : null;
  const title = clip(d.title || '', 250);
  const docText = [symbol, title, String(d.body ?? '')].filter(Boolean).join('\n');
  const metadata = { ...(d.meta || {}), kind: d.kind, ...(title ? { title } : {}), ...(symbol ? { symbol } : {}), ...(d.source ? { source: String(d.source).slice(0, 64) } : {}) };
  const res = await exec(
    `INSERT INTO rag_documents (source_table, source_id, doc_text, metadata, env)
     VALUES (:kind,:sid,:txt,CAST(:meta AS JSON),:env)`,
    { kind: clip(d.kind, 64), sid: d.sourceId ?? null, txt: docText, meta: JSON.stringify(metadata), env: d.env ?? null },
  );
  return res.insertId;
}

// ── embedding backfill ──────────────────────────────────────────────────────

// Text each corpus is embedded from. learnings has no single text column, so the
// title and body are concatenated exactly as the FULLTEXT index sees them.
const TARGETS: { table: 'rag_documents' | 'learnings'; text: string }[] = [
  { table: 'rag_documents', text: 'doc_text' },
  { table: 'learnings', text: "CONCAT_WS(' ', title, body)" },
];

let dormantLogged = false;
// The model rows are being written with right now. Starts at the configured id and
// follows the ladder if NIM falls back, so one run cannot fight itself re-embedding
// the rows it just wrote with a fallback model.
let activeModel = '';

async function pendingCount(model: string): Promise<number> {
  let n = 0;
  for (const t of TARGETS) {
    const [r] = await q<{ n: number }>(
      `SELECT COUNT(*) n FROM ${t.table}
       WHERE (embedding IS NULL OR embed_model IS NULL OR embed_model <> :m) AND ${t.text} IS NOT NULL AND ${t.text} <> ''`,
      { m: model },
    );
    n += Number(r?.n || 0);
  }
  return n;
}

export type EmbedResult = { dormant: boolean; model: string; embedded: number; failed: number; pending: number };

/** Embed rows that have no vector, or whose vector came from a different model.
 *  Small batches, newest first. Never throws: embeddings are an enhancement. */
export async function embedPending(opts: { limit?: number } = {}): Promise<EmbedResult> {
  if (!activeModel) activeModel = currentEmbedModel();
  if (embeddingsDormant()) {
    if (!dormantLogged) { dormantLogged = true; console.log('[rag] embeddings dormant: NVIDIA_API_KEY not set'); }
    return { dormant: true, model: activeModel, embedded: 0, failed: 0, pending: await pendingCount(activeModel).catch(() => 0) };
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 32, 1), 200);
  let embedded = 0;
  let failed = 0;
  for (const t of TARGETS) {
    let budget = limit;
    while (budget > 0) {
      const batch = Math.min(16, budget);
      const rows = await q<{ id: number; txt: string }>(
        `SELECT id, ${t.text} txt FROM ${t.table}
         WHERE (embedding IS NULL OR embed_model IS NULL OR embed_model <> :m) AND ${t.text} IS NOT NULL AND ${t.text} <> ''
         ORDER BY id DESC LIMIT :lim`,
        { m: activeModel, lim: batch },
      ).catch(() => []);
      if (!rows.length) break;
      const res = await embedTexts(rows.map((r) => String(r.txt).slice(0, 8000)), 'passage').catch(() => null);
      // Null = no key or every ladder id failed. Stop the run rather than spin on the
      // same rows; the next 10-minute tick retries.
      if (!res || res.vectors.length !== rows.length) { failed += rows.length; return { dormant: false, model: activeModel, embedded, failed, pending: await pendingCount(activeModel).catch(() => 0) }; }
      activeModel = res.model;
      for (let i = 0; i < rows.length; i++) {
        await exec(
          `UPDATE ${t.table} SET embedding=CAST(:v AS JSON), embed_model=:m, embedded_at=NOW() WHERE id=:id`,
          { v: JSON.stringify(res.vectors[i]), m: res.model, id: rows[i].id },
        ).then(() => { embedded++; }).catch(() => { failed++; });
      }
      budget -= rows.length;
      if (rows.length < batch) break;
    }
  }
  const pending = await pendingCount(activeModel).catch(() => 0);
  if (embedded || failed) await audit('rag.embed', `embedded ${embedded} rows (${activeModel}), ${failed} failed, ${pending} pending`);
  return { dormant: false, model: activeModel, embedded, failed, pending };
}

// ── stats ───────────────────────────────────────────────────────────────────

/** Corpus health: rows per account (NULL shown as 'shared') and embedding coverage. */
export async function knowledgeStats(): Promise<any> {
  const env = await getTradingEnv();
  const model = currentEmbedModel();
  const tables: Record<string, any> = {};
  for (const table of ['learnings', 'ticker_insights', 'rag_documents']) {
    const rows = await q<{ env: string; n: number }>(
      `SELECT COALESCE(env,'shared') env, COUNT(*) n FROM ${table} GROUP BY COALESCE(env,'shared')`,
    ).catch(() => []);
    const by_env: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { by_env[r.env] = Number(r.n); total += Number(r.n); }
    const entry: any = { total, by_env };
    if (table !== 'ticker_insights') {
      const [e] = await q<{ n: number; cur: number }>(
        `SELECT COUNT(embedding) n, SUM(CASE WHEN embedding IS NOT NULL AND embed_model=:m THEN 1 ELSE 0 END) cur FROM ${table}`,
        { m: model },
      ).catch(() => [] as any);
      entry.embedded = Number(e?.n || 0);
      entry.embedded_current_model = Number(e?.cur || 0);
      // Same definition as the backfill's own queue (blank-text rows are never embedded,
      // so they must not count as pending forever). (CP3 gate)
      const txt = TARGETS.find((t) => t.table === table)?.text;
      const [pnd] = txt
        ? await q<{ n: number }>(
            `SELECT COUNT(*) n FROM ${table} WHERE (embedding IS NULL OR embed_model IS NULL OR embed_model <> :m) AND ${txt} IS NOT NULL AND ${txt} <> ''`,
            { m: model },
          ).catch(() => [] as any)
        : [];
      entry.pending = Number(pnd?.n ?? (total - Number(e?.cur || 0)));
    }
    tables[table] = entry;
  }
  return { env, embed: { model, dormant: embeddingsDormant(), ladder: EMBED_LADDER }, tables };
}
