import { ping, q } from './db.js';
import { PROVIDERS, isOptionalDeskProvider, providerStatus, probeProviders, probedOnce, sanitizeError, type ProviderName } from './ai/models.js';
import { museActivity } from './ai/activity.js';
import { hydrateWatchStatus, watchStatus } from './watch.js';
import { alpacaConfigured, alpacaPaper } from './brokers/alpaca.js';

/** UI lamp color: green = configured + last probe ok, amber = key present but not live, gray = no key. */
export type ConnKind = 'green' | 'amber' | 'gray';

export type Connection = {
  id: string;
  label: string;
  configured: boolean;
  live: boolean | null;
  defaultModel: string | null;
  lastProbeAt: string | null;
  error: string | null;
  kind: ConnKind;
};

const PROVIDER_LABEL: Record<ProviderName, string> = {
  muse: 'Muse',
  groq: 'Groq',
  nvidia: 'NVIDIA',
  kimi: 'Kimi',
  anthropic: 'Anthropic',
  local: 'Local',
};

/** Chip order: Muse first (desk ops lamp), then the rest of the cascade, paper broker, DB. */
const PROVIDER_ORDER: ProviderName[] = ['muse', 'groq', 'nvidia', 'kimi', 'anthropic', 'local'];

function kindOf(configured: boolean, live: boolean | null): ConnKind {
  if (configured && live === true) return 'green';
  if (configured) return 'amber';
  return 'gray';
}

function withKind(c: Omit<Connection, 'kind'>): Connection {
  return { ...c, kind: kindOf(c.configured, c.live) };
}

type ProbeCache = { live: boolean | null; at: number | null; error: string | null };
let alpacaCache: ProbeCache = { live: null, at: null, error: null };
let alpacaInflight: Promise<void> | null = null;
let dbCache: ProbeCache = { live: null, at: null, error: null };

export async function probeAlpaca(): Promise<void> {
  if (alpacaInflight) return alpacaInflight;
  alpacaInflight = (async () => {
    if (!alpacaConfigured()) {
      alpacaCache = { live: null, at: null, error: null };
      return;
    }
    try {
      await alpacaPaper.account();
      alpacaCache = { live: true, at: Date.now(), error: null };
    } catch (e: any) {
      alpacaCache = { live: false, at: Date.now(), error: sanitizeError(e?.message || e) };
    }
  })().finally(() => { alpacaInflight = null; });
  return alpacaInflight;
}

async function probeDb(): Promise<void> {
  const ok = await ping();
  dbCache = { live: ok, at: Date.now(), error: ok ? null : 'unreachable' };
}

async function corpusCounts(): Promise<{ news: number; learnings: number; learning_runs: number }> {
  const empty = { news: 0, learnings: 0, learning_runs: 0 };
  if (dbCache.live !== true) return empty;
  try {
    const [n] = await q<{ n: number }>('SELECT COUNT(*) n FROM news');
    const [l] = await q<{ n: number }>('SELECT COUNT(*) n FROM learnings');
    const [r] = await q<{ n: number }>('SELECT COUNT(*) n FROM learning_runs');
    return { news: Number(n?.n || 0), learnings: Number(l?.n || 0), learning_runs: Number(r?.n || 0) };
  } catch {
    return empty;
  }
}

export async function connectionStatus(opts: { probe?: boolean } = {}): Promise<{
  providers: Record<string, Connection>;
  alpaca: Connection;
  db: Connection;
  corpus: { news: number; learnings: number; learning_runs: number };
  chips: Connection[];
  muse: ReturnType<typeof museActivity>;
  watch: ReturnType<typeof watchStatus>;
}> {
  if (opts.probe) {
    const jobs: Promise<void>[] = [probeAlpaca(), probeDb()];
    if (!probedOnce()) jobs.unshift(probeProviders());
    await Promise.all(jobs);
  } else {
    await probeDb();
  }

  const raw = providerStatus();
  const providers: Record<string, Connection> = {};
  for (const id of PROVIDERS) {
    const p = raw[id];
    providers[id] = withKind({
      id,
      label: PROVIDER_LABEL[id],
      configured: p.configured,
      live: p.live,
      defaultModel: p.defaultModel,
      lastProbeAt: p.lastProbeAt,
      error: p.error,
    });
  }

  const alpaca = withKind({
    id: 'alpaca',
    label: 'Alpaca paper',
    configured: alpacaConfigured(),
    live: alpacaCache.live,
    defaultModel: null,
    lastProbeAt: alpacaCache.at ? new Date(alpacaCache.at).toISOString() : null,
    error: alpacaCache.error,
  });

  const db = withKind({
    id: 'db',
    label: 'DB',
    configured: true,
    live: dbCache.live,
    defaultModel: null,
    lastProbeAt: dbCache.at ? new Date(dbCache.at).toISOString() : null,
    error: dbCache.error,
  });

  // Muse / Groq / NVIDIA / Kimi always show. Anthropic and Local only when live
  // (401 Anthropic and unset Local stay off the strip). Alpaca + DB stay.
  const chips = [
    ...PROVIDER_ORDER
      .map((id) => providers[id])
      .filter((c) => !isOptionalDeskProvider(c.id as ProviderName) || (c.configured && c.live === true)),
    alpaca,
    db,
  ];
  await hydrateWatchStatus().catch(() => {});
  return {
    providers,
    alpaca,
    db,
    corpus: await corpusCounts(),
    chips,
    muse: museActivity(),
    watch: watchStatus(),
  };
}
