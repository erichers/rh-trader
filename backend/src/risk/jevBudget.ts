/**
 * Jev / TypeSafe spend tracker. Eric’s prepaid budget is ~$5.
 *
 * TypeSafe list price is $0.042 / 1M input tokens. We overestimate slightly
 * at $0.05 / 1M ($0.00005 per 1k input) so the reserve trips before the card does.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';

/** Documented overestimate of TypeSafe input price ($0.042/1M → $0.05/1M). */
export const JEV_USD_PER_1K_INPUT = 0.00005;
export const JEV_BUDGET_USD_DEFAULT = 5;
export const JEV_BUDGET_RESERVE_USD_DEFAULT = 0.50;

export type JevSpendFile = {
  spentUsd: number;
  budgetUsd: number;
  reserveUsd: number;
  degraded: boolean;
  reason: string | null;
  warned50: boolean;
  warned80: boolean;
  updatedAt: string;
};

export type JevHealth = {
  ok: boolean;
  mode: string;
  spentUsd: number;
  budgetUsd: number;
  degraded: boolean;
  reason: string | null;
};

export type JevBudgetIo = {
  read?: () => Promise<string | null>;
  write?: (json: string) => Promise<void>;
  log?: (line: string) => void;
};

let processDegraded = false;
let processReason: string | null = null;
let warned50 = false;
let warned80 = false;
let cached: JevSpendFile | null = null;
let loggedDegrade = false;

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function jevBudgetPath(): string {
  return config.typesafe.spendPath;
}

export function defaultSpend(seed?: Partial<JevSpendFile>): JevSpendFile {
  return {
    spentUsd: num(seed?.spentUsd ?? config.typesafe.spentUsdSeed, 0),
    budgetUsd: num(seed?.budgetUsd ?? config.typesafe.budgetUsd, JEV_BUDGET_USD_DEFAULT),
    reserveUsd: num(seed?.reserveUsd ?? config.typesafe.reserveUsd, JEV_BUDGET_RESERVE_USD_DEFAULT),
    degraded: !!(seed?.degraded || processDegraded),
    reason: seed?.reason ?? processReason,
    warned50: !!(seed?.warned50 || warned50),
    warned80: !!(seed?.warned80 || warned80),
    updatedAt: seed?.updatedAt || new Date().toISOString(),
  };
}

export function estimateCallUsd(inputTokens: number, usdPer1k = JEV_USD_PER_1K_INPUT): number {
  const t = Number(inputTokens);
  if (!Number.isFinite(t) || t <= 0) return usdPer1k; // assume ≥1k tokens if usage missing
  return (t / 1000) * usdPer1k;
}

export function remainingUsd(s: JevSpendFile): number {
  return s.budgetUsd - s.spentUsd;
}

export function shouldDegrade(s: JevSpendFile): boolean {
  return s.degraded || remainingUsd(s) <= s.reserveUsd;
}

export function isPaymentOrCreditError(msg: string, status?: number): boolean {
  const t = String(msg || '');
  if (status === 402) return true;
  if ((status === 401 || status === 429) && /insufficient|payment|credit|billing|quota|prepaid/i.test(t)) return true;
  return /insufficient (funds|credit|quota)|payment required|out of (funds|credit)|prepaid|402\b/i.test(t);
}

export function jevHealthSnapshot(s: JevSpendFile, mode = config.typesafe.entryMode): JevHealth {
  return {
    ok: !shouldDegrade(s),
    mode,
    spentUsd: Math.round(s.spentUsd * 1e6) / 1e6,
    budgetUsd: s.budgetUsd,
    degraded: shouldDegrade(s),
    reason: s.reason,
  };
}

function applyWarns(s: JevSpendFile, log: (line: string) => void): JevSpendFile {
  const used = s.budgetUsd > 0 ? s.spentUsd / s.budgetUsd : 1;
  if (used >= 0.5 && !s.warned50) {
    s.warned50 = true;
    warned50 = true;
    log(`[jev] budget 50% — spent $${s.spentUsd.toFixed(4)} / $${s.budgetUsd}`);
  }
  if (used >= 0.8 && !s.warned80) {
    s.warned80 = true;
    warned80 = true;
    log(`[jev] budget 80% — spent $${s.spentUsd.toFixed(4)} / $${s.budgetUsd}; reserve $${s.reserveUsd}`);
  }
  return s;
}

export function markDegraded(s: JevSpendFile, reason: string, log: (line: string) => void): JevSpendFile {
  s.degraded = true;
  s.reason = reason.slice(0, 240);
  processDegraded = true;
  processReason = s.reason;
  if (!loggedDegrade) {
    loggedDegrade = true;
    log(`[jev] DEGRADED — ${s.reason}. Falling back to local decide + optional Kimi/Groq review. TypeSafe calls stopped.`);
  }
  return s;
}

async function readSpend(io?: JevBudgetIo): Promise<JevSpendFile> {
  if (cached) return { ...cached, degraded: cached.degraded || processDegraded, reason: cached.reason || processReason };
  try {
    const raw = io?.read ? await io.read() : await readFile(jevBudgetPath(), 'utf8').catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw);
      cached = defaultSpend(parsed);
      warned50 = cached.warned50;
      warned80 = cached.warned80;
      if (cached.degraded) markDegraded(cached, cached.reason || 'persisted degrade', io?.log || console.warn);
      return { ...cached };
    }
  } catch { /* seed */ }
  cached = defaultSpend();
  return { ...cached };
}

async function writeSpend(s: JevSpendFile, io?: JevBudgetIo): Promise<void> {
  cached = s;
  const json = JSON.stringify(s, null, 2);
  try {
    if (io?.write) {
      await io.write(json);
      return;
    }
    const p = jevBudgetPath();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, json, 'utf8');
  } catch { /* never block the desk */ }
}

export async function loadJevSpend(io?: JevBudgetIo): Promise<JevSpendFile> {
  return readSpend(io);
}

export function canCallJevApi(s: JevSpendFile): boolean {
  return !shouldDegrade(s);
}

export async function recordJevUsage(opts: {
  inputTokens?: number | null;
  error?: string | null;
  status?: number;
  io?: JevBudgetIo;
}): Promise<JevSpendFile> {
  const log = opts.io?.log || console.warn;
  const s = await readSpend(opts.io);
  if (opts.error && isPaymentOrCreditError(opts.error, opts.status)) {
    markDegraded(s, `payment/credit: ${opts.error}`.slice(0, 240), log);
    s.updatedAt = new Date().toISOString();
    await writeSpend(s, opts.io);
    return s;
  }
  const add = estimateCallUsd(Number(opts.inputTokens) || 0);
  s.spentUsd = Math.round((s.spentUsd + add) * 1e8) / 1e8;
  applyWarns(s, log);
  if (shouldDegrade(s) && !s.degraded) {
    markDegraded(s, `remaining $${remainingUsd(s).toFixed(4)} ≤ reserve $${s.reserveUsd}`, log);
  }
  s.updatedAt = new Date().toISOString();
  await writeSpend(s, opts.io);
  return s;
}

export async function jevHealth(io?: JevBudgetIo): Promise<JevHealth> {
  const s = await loadJevSpend(io);
  return jevHealthSnapshot(s);
}

/** Tests only. */
export function resetJevBudgetForTests(): void {
  processDegraded = false;
  processReason = null;
  warned50 = false;
  warned80 = false;
  cached = null;
  loggedDegrade = false;
}

export async function appendBudgetNote(line: string): Promise<void> {
  try {
    const p = config.typesafe.logPath;
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify({ ts: new Date().toISOString(), event: 'jev.budget', line })}\n`, 'utf8');
  } catch { /* ignore */ }
}
