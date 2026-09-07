import { config } from '../config.js';
import { audit } from '../db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Model registry: the ONE place model ids live. Everything else asks for a TASK.
//
// LAW (2026-08-24, reaffirmed 2026-08-25): never assume a model id outlives the
// week. Groq retired every llama-3.x chat model in Aug 2026. Ids below carry the
// date they were last verified against the provider's own /models endpoint;
// probeProviders() re-verifies at boot and every 6h and walks the ladder when a
// configured id has gone dark. The cascade in llm.ts still catches everything else.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'kimi' | 'groq' | 'nvidia' | 'muse' | 'local';
export type Task = 'chat' | 'triage' | 'research' | 'agent' | 'review' | 'ideas' | 'watch' | 'performance';
export type ChainEntry = { provider: ProviderName; model: string };
export type ResolvedEntry = ChainEntry & { live: boolean | null };

export const TASKS: Task[] = ['chat', 'triage', 'research', 'agent', 'review', 'ideas', 'watch', 'performance'];
export const PROVIDERS: ProviderName[] = ['anthropic', 'kimi', 'groq', 'nvidia', 'muse', 'local'];

/** Per-provider fallback ladder, best first. Used when a chain's id is not live. */
export const LADDER: Record<ProviderName, string[]> = {
  // Anthropic: id comes from ANTHROPIC_MODEL (no key here yet, so unverified).
  anthropic: [config.anthropic.model],
  // Moonshot /v1/models, verified live 2026-08-25.
  kimi: ['kimi-k2.5', 'kimi-k2.6', 'kimi-k3', 'moonshot-v1-128k'],
  // Groq /openai/v1/models, verified live 2026-08-25. Free tier: 30 RPM / 1K RPD /
  // 8K TPM / 200K TPD per model; groq/compound 250 RPD, 70K TPM. Heavy prompts must
  // not lead with Groq.
  // groq/compound deliberately excluded: no custom tools, no response_format (Groq docs 2026-08-25).
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
  // NVIDIA NIM (OpenAI-compatible, ~40 RPM per key). Ids from NIM docs 2026-08-25,
  // NOT verified live here (no key yet) — the boot probe will confirm or fall through.
  nvidia: [
    // Verified live against integrate.api.nvidia.com/v1/models on 2026-08-25 (95 ids).
    // meta/llama-3.3-70b-instruct is listed but hung for 90s+ on every probe: excluded.
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'openai/gpt-oss-120b',
    'qwen/qwen3-235b-a22b',
    'moonshotai/kimi-k2-instruct',
  ],
  // Meta Model API https://api.meta.ai/v1 — OpenAI-compatible Chat Completions + GET /v1/models
  // (docs 2026-09). Default and recommended id is PAYG Standard muse-spark-1.3 (chat 200).
  // Walk to muse-spark-1.1 if 1.3 is dark. Contributor stays last on the ladder only.
  muse: ['muse-spark-1.3', 'muse-spark-1.1', 'muse-spark-1.3-contributor'],
  // Self-hosted OpenAI-compatible server: whatever model LOCAL_MODEL names (no ladder to walk).
  local: [config.local.model || 'local-model'],
};

/** Embedding ladder (NVIDIA NIM /v1/embeddings), docs 2026-08-25, unverified live. */
export const EMBED_LADDER = ['nvidia/nemotron-3-embed-1b', 'snowflake/arctic-embed-l', 'nvidia/embed-qa-4'];

/** The id an env override replaces (each provider's default pick). */
const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: LADDER.anthropic[0],
  kimi: LADDER.kimi[0],
  groq: LADDER.groq[0],
  nvidia: LADDER.nvidia[0],
  muse: LADDER.muse[0],
  local: LADDER.local[0],
};

const N_LLAMA = 'nvidia/nemotron-3-super-120b-a12b'; // sub-second with thinking off, tool calling; llama-3.3-70b hangs on NIM (2026-08-25)
const N_NEMOTRON = 'nvidia/llama-3.3-nemotron-super-49b-v1.5';
const N_DEEPSEEK = 'nvidia/nemotron-3-super-120b-a12b'; // deepseek-v3.1 is not on NIM (checked 2026-08-25); Nemotron-3 Super is the reasoning workhorse

/** Ordered chain per task. Desk policy (paper / Observe):
 *  chat leads with Muse Spark for conversational quality; triage stays Groq-first
 *  (cheap, many calls); research / review / ideas lead NVIDIA then Groq (Muse is
 *  the backup); agent / watch / performance lead with Muse Spark.
 *  Unconfigured providers are skipped. Anthropic stays on the chain but may be invalid. */
export const TASK_CHAINS: Record<Task, ChainEntry[]> = {
  // Ask AI / text-to-SQL: Muse first when configured+live; Groq is the fast fallback.
  chat: [
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'nvidia', model: N_LLAMA },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // News classification / quick ticker reads: tiny prompts, many calls per day.
  triage: [
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'nvidia', model: N_LLAMA },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Long analytical prompts. NVIDIA first, Groq second, Muse as backup.
  research: [
    { provider: 'nvidia', model: N_DEEPSEEK },
    { provider: 'nvidia', model: N_NEMOTRON },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Tool loops: Muse for short ops judgments; NVIDIA/Groq if Muse is dark.
  agent: [
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'nvidia', model: N_LLAMA },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Daily learning pass over many trades. Long prompt: NVIDIA then Groq, Muse backup.
  review: [
    { provider: 'nvidia', model: N_DEEPSEEK },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Strategy idea generation. Same shape as review.
  ideas: [
    { provider: 'nvidia', model: N_DEEPSEEK },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Observe-only ticker watch: short news + indicator take. Muse first.
  watch: [
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'nvidia', model: N_LLAMA },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
  // Paper-account performance / ops note. Muse first. Never places an order.
  performance: [
    { provider: 'muse', model: DEFAULT_MODEL.muse },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'nvidia', model: N_LLAMA },
    { provider: 'kimi', model: 'kimi-k2.5' },
    { provider: 'anthropic', model: DEFAULT_MODEL.anthropic },
    { provider: 'local', model: DEFAULT_MODEL.local },
  ],
};

export function providerConfig(name: ProviderName): { apiKey: string; baseUrl: string; model: string } {
  if (name === 'anthropic') return { apiKey: config.anthropic.apiKey, baseUrl: 'https://api.anthropic.com/v1', model: config.anthropic.model };
  if (name === 'kimi') return config.kimi;
  if (name === 'groq') return config.groq;
  if (name === 'muse') return config.muse;
  if (name === 'local') return config.local;
  return config.nvidia;
}

export function isConfigured(name: ProviderName): boolean {
  if (name === 'local') return !!(config.local.baseUrl && config.local.model); // self-hosted: a key is optional
  return !!providerConfig(name).apiKey;
}

/** Disaster drill: LLM_POISON_PROVIDERS=groq,kimi makes those providers throw on
 *  every call so the fallback path can be proven without touching code. */
export function isPoisoned(name: ProviderName): boolean {
  return (process.env.LLM_POISON_PROVIDERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(name);
}

/** GROQ_MODEL / KIMI_MODEL / NVIDIA_MODEL / ANTHROPIC_MODEL / META_MUSE_MODEL
 *  (or MUSE_MODEL) stay honored: they replace that provider's DEFAULT pick
 *  wherever a chain uses it (slots picked deliberately for cost, like the 20b
 *  triage lead, keep their own id). Empty Muse override keeps muse-spark-1.3. */
function preferred(name: ProviderName): string {
  const m = providerConfig(name).model;
  return m || DEFAULT_MODEL[name];
}

function ladderFor(name: ProviderName): string[] {
  const p = preferred(name);
  return [p, ...LADDER[name].filter((m) => m !== p)];
}

// ── Liveness probe ───────────────────────────────────────────────────────────
type ProbeState = { live: Set<string>; probed_at: number | null; last_attempt_at: number | null; error: string | null };
const probes: Record<ProviderName, ProbeState> = {
  anthropic: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
  kimi: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
  groq: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
  nvidia: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
  muse: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
  local: { live: new Set(), probed_at: null, last_attempt_at: null, error: null },
};

/** Strip anything that looks like a secret from probe error text before it leaves the process. */
export function sanitizeError(s: string | null | undefined): string | null {
  if (!s) return null;
  return String(s)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/nvapi-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/APCA-API-[A-Z-]+/gi, '[redacted-header]')
    .slice(0, 160);
}

async function probeOne(name: ProviderName): Promise<void> {
  const st = probes[name];
  const now = Date.now();
  if (isPoisoned(name)) { st.live = new Set(); st.probed_at = null; st.last_attempt_at = now; st.error = 'poisoned via LLM_POISON_PROVIDERS'; return; }
  const { apiKey, baseUrl } = providerConfig(name);
  try {
    const headers: Record<string, string> = name === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {}; // self-hosted servers may run without a key
    const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5_000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 120)}`);
    const ids: string[] = (JSON.parse(text).data || []).map((m: any) => String(m.id)).filter(Boolean);
    if (!ids.length) throw new Error('empty model list');
    st.live = new Set(ids);
    st.probed_at = now;
    st.last_attempt_at = now;
    st.error = null;
  } catch (e: any) {
    st.live = new Set();
    st.probed_at = null; // a failed probe means "unknown" for chain resolution, not "nothing is live"
    st.last_attempt_at = now;
    st.error = String(e?.message || e).slice(0, 160);
  }
}

/** Refresh the live-id cache for every configured provider. Never throws. */
export async function probeProviders(): Promise<void> {
  const names = PROVIDERS.filter(isConfigured);
  await Promise.all(names.map(probeOne));
  const summary = names.map((n) => `${n}:${probes[n].error ? 'err' : probes[n].live.size}`).join(' ');
  console.log(`[models] probe ${summary || 'no provider configured'}`);
}

export function probedOnce(): boolean {
  return PROVIDERS.some((n) => probes[n].probed_at != null || probes[n].error != null);
}

/** The id this provider will actually send (env override, else the ladder default). Never a secret. */
export function defaultModelId(name: ProviderName): string {
  return preferred(name);
}

export type ProviderStatus = {
  configured: boolean;
  live: boolean | null;
  defaultModel: string;
  lastProbeAt: string | null;
  live_ids: number;
  probed_at: string | null;
  error: string | null;
};

export function providerStatus(): Record<string, ProviderStatus> {
  const out: Record<string, ProviderStatus> = {};
  for (const n of PROVIDERS) {
    const st = probes[n];
    const lastAttempt = st.last_attempt_at ?? st.probed_at;
    const live = st.probed_at != null && st.live.size > 0
      ? true
      : (st.error != null || st.last_attempt_at != null) && st.probed_at == null ? false : null;
    out[n] = {
      configured: isConfigured(n),
      live,
      defaultModel: preferred(n),
      lastProbeAt: lastAttempt ? new Date(lastAttempt).toISOString() : null,
      live_ids: st.live.size,
      probed_at: st.probed_at ? new Date(st.probed_at).toISOString() : null,
      error: sanitizeError(st.error),
    };
  }
  return out;
}

const announced = new Set<string>();

/** Swap a dead id for the first live id on that provider's ladder. Only acts on a
 *  SUCCESSFUL probe: if the probe failed we know nothing, so keep the configured id
 *  and let the cascade handle a real error. */
function resolveEntry(e: ChainEntry): ResolvedEntry {
  const model = e.model === DEFAULT_MODEL[e.provider] ? preferred(e.provider) : e.model;
  const st = probes[e.provider];
  if (st.probed_at == null) return { provider: e.provider, model, live: null };
  if (st.live.has(model)) return { provider: e.provider, model, live: true };
  const alt = ladderFor(e.provider).find((m) => st.live.has(m));
  if (!alt) return { provider: e.provider, model, live: false };
  const key = `${e.provider}:${model}->${alt}`;
  if (!announced.has(key)) {
    announced.add(key);
    console.warn(`[models] ${e.provider} ${model} is not live, using ${alt}`);
    void audit('ai.model.fallback', `${e.provider} ${model} not live, using ${alt}`, { provider: e.provider, from: model, to: alt }).catch(() => {});
  }
  return { provider: e.provider, model: alt, live: true };
}

/** The resolved chain for a task: configured providers only, env preference applied,
 *  dead ids walked down the ladder, duplicates collapsed. */
export function resolveChain(task: Task): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  const seen = new Set<string>();
  for (const e of TASK_CHAINS[task]) {
    if (!isConfigured(e.provider)) continue;
    const r = resolveEntry(e);
    const key = `${r.provider}:${r.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  // Probe-confirmed dead ids are skipped so a task never leads with a known-404 model;
  // if EVERY entry is dead, keep them so the cascade error names what failed.
  const alive = out.filter((r) => r.live !== false);
  return alive.length ? alive : out;
}

/** First resolved entry for a task (what a caller will actually hit first). */
export function firstFor(task: Task): ResolvedEntry | null {
  return resolveChain(task)[0] || null;
}
