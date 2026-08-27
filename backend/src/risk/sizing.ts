import { getRiskLimits, getTradeDefaults, type TradeDefaults } from '../db.js';
import { resolveCaps, type OrderDraft } from './engine.js';
import type { TradingEnv } from '../config.js';

// ONE place that answers "how much money goes into this trade, and where does it exit?".
// Global defaults live in settings.trade_defaults (db.ts); a bot overrides any field in
// its own `bots.risk` JSON; absent/null on the bot means "use the global". The risk engine
// remains the hard ceiling — the sizer never proposes a notional the gate would veto.

/** Options trade in 100-share contracts; the quoted premium is per share. */
const CONTRACT_MULT = 100;

export const RISK_FIELDS = ['amount_usd', 'min_usd', 'max_usd', 'take_profit_pct', 'stop_loss_pct', 'trailing_stop_pct'] as const;
export type RiskField = (typeof RISK_FIELDS)[number];

export type EffectiveRisk = TradeDefaults & {
  /** Where each effective value came from, so the UI can tag inherited fields. */
  source: Record<RiskField, 'bot' | 'global'>;
  /** Human-readable record of any clamp this resolve had to apply. */
  notes?: string[];
};

/** A per-bot override is used only when it is a real, positive number. `take_profit_pct`
 *  is the exception: an explicit 0 is meaningful ("no cap, ride the trail") and is kept. */
function pick(raw: any, global: number, allowZero: boolean): { value: number; source: 'bot' | 'global' } {
  if (raw == null || raw === '') return { value: global, source: 'global' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { value: global, source: 'global' };
  if (n === 0 && !allowZero) return { value: global, source: 'global' };
  return { value: n, source: 'bot' };
}

/** `amount_usd` is opt-in: no bot override and no global default means "unset" — sizing
 *  is skipped entirely, so `null` must survive here rather than falling back to a number. */
function pickAmount(raw: any, global: number | null): { value: number | null; source: 'bot' | 'global' } {
  if (raw == null || raw === '') return { value: global, source: 'global' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { value: global, source: 'global' };
  return { value: n, source: 'bot' };
}

/** Resolve a bot's risk JSON against the global trade defaults (pure). */
export function resolveRiskWith(risk: any, g: TradeDefaults): EffectiveRisk {
  const r = (typeof risk === 'string' ? safeParse(risk) : risk) || {};
  const f = {
    amount_usd: pickAmount(r.amount_usd, g.amount_usd),
    min_usd: pick(r.min_usd, g.min_usd, false),
    max_usd: pick(r.max_usd, g.max_usd, false),
    take_profit_pct: pick(r.take_profit_pct, g.take_profit_pct, true),
    stop_loss_pct: pick(r.stop_loss_pct, g.stop_loss_pct, false),
    trailing_stop_pct: pick(r.trailing_stop_pct, g.trailing_stop_pct, false),
  };
  const out: any = { source: {} };
  for (const k of RISK_FIELDS) { out[k] = f[k].value; out.source[k] = f[k].source; }
  // Keep the money fields ordered even when a bot overrides only one of them — but a
  // bot-level amount must never RAISE a global max_usd. Reordering (moving max up to meet
  // amount) only happens when both fields share the same source; otherwise the amount is
  // the one that gives, clamped down to the tighter (global) max.
  if (out.amount_usd != null) {
    if (out.min_usd > out.amount_usd) out.min_usd = out.amount_usd;
    if (out.max_usd < out.amount_usd) {
      if (out.source.max_usd === out.source.amount_usd) {
        out.max_usd = out.amount_usd;
      } else {
        out.notes = [...(out.notes || []), `amount clamped from ${out.amount_usd} to ${out.max_usd} (bot amount cannot exceed global max)`];
        out.amount_usd = out.max_usd;
      }
    }
  }
  return out as EffectiveRisk;
}

/** Effective risk for a bot row (or a bare risk object / JSON string). */
export async function resolveBotRisk(bot: any): Promise<EffectiveRisk> {
  const risk = bot && typeof bot === 'object' && 'risk' in bot ? (bot as any).risk : bot;
  return resolveRiskWith(risk, await getTradeDefaults());
}

export type SizeDecision = {
  ok: boolean;
  qty: number;
  notional: number;
  unit_cost: number;          // cost of ONE unit (share, or contract = premium × 100)
  basis: 'amount' | 'pinned' | 'unpriced' | 'unsized';
  reason: string;
};

/** Turn a dollar budget into whole units. Pure — no DB, no network.
 *  `pinnedQty` keeps a deliberately configured quantity, but max/min still apply. */
export function sizeTrade(opts: {
  price: number;
  assetClass: string;
  amount_usd: number;
  min_usd: number;
  max_usd: number;
  pinnedQty?: number | null;
}): SizeDecision {
  const isOption = (opts.assetClass || 'equity').toLowerCase() === 'option';
  const unit = Number(opts.price) > 0 ? Number(opts.price) * (isOption ? CONTRACT_MULT : 1) : 0;
  const label = isOption ? 'contract' : 'share';
  const pinned = Number(opts.pinnedQty);
  const havePin = Number.isFinite(pinned) && pinned > 0;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

  if (!(unit > 0)) {
    // No usable price (option contract unresolved, no quote). Leave the quantity alone and
    // let the risk engine do its job — it vetoes an unpriceable option buy outright.
    return { ok: true, qty: havePin ? Math.floor(pinned) : 1, notional: 0, unit_cost: 0, basis: 'unpriced', reason: 'no price yet — sizing deferred to the risk engine' };
  }

  let qty = havePin ? Math.floor(pinned) : Math.max(1, Math.floor(opts.amount_usd / unit));
  const basis: SizeDecision['basis'] = havePin ? 'pinned' : 'amount';

  // Hard ceiling: never propose more than max_usd (which already folds in the engine cap).
  if (qty * unit > opts.max_usd) qty = Math.floor(opts.max_usd / unit);
  if (qty < 1) {
    return { ok: false, qty: 0, notional: 0, unit_cost: unit, basis, reason: `one ${label} costs ${usd(unit)}, above the ${usd(opts.max_usd)} maximum per trade` };
  }
  const notional = qty * unit;
  if (notional < opts.min_usd) {
    return { ok: false, qty: 0, notional, unit_cost: unit, basis, reason: `${qty} ${label}${qty > 1 ? 's' : ''} = ${usd(notional)}, below the ${usd(opts.min_usd)} minimum per trade` };
  }
  return { ok: true, qty, notional, unit_cost: unit, basis, reason: `${qty} ${label}${qty > 1 ? 's' : ''} ≈ ${usd(notional)} (target ${usd(opts.amount_usd)})` };
}

/** Size a BOT draft in place: resolves the option contract first (so the premium is real),
 *  then converts the effective amount_usd into whole units. `pinnedQty` is the bot's own
 *  deliberate quantity, used instead of the dollar target when it opts out of sizing.
 *  Returns the decision — an `ok:false` result means the caller must SKIP the trade.
 *  Never widens anything: the ceiling is min(effective max_usd, the risk engine's own cap). */
export async function sizeDraft(
  draft: OrderDraft,
  opts: { risk?: any; pinnedQty?: number | null; env: TradingEnv },
): Promise<SizeDecision & { effective: EffectiveRisk }> {
  const effective = await resolveBotRisk(opts.risk);
  // Sizing is opt-in: no bot or global amount_usd means "leave the quantity alone", exactly
  // as before this feature existed. Only buys are sized — an exit keeps its own quantity.
  if (draft.side !== 'buy' || effective.amount_usd == null) {
    return { ok: true, qty: draft.qty, notional: 0, unit_cost: 0, basis: 'unsized', reason: 'no amount per trade set — sizing skipped', effective };
  }
  const caps = resolveCaps(opts.risk, draft._play, await getRiskLimits());
  const ac = (draft.asset_class || 'equity').toLowerCase();
  if (ac === 'option' && !(Number(draft.est_price) > 0)) {
    const { resolveDraftContract } = await import('../execute.js');
    await resolveDraftContract(draft, opts.env);
  }
  const price = Number(draft.est_price ?? draft.limit_price ?? 0);
  const d = sizeTrade({
    price,
    assetClass: ac,
    amount_usd: effective.amount_usd,
    min_usd: effective.min_usd,
    max_usd: Math.min(effective.max_usd, caps.maxPositionUsd),
    pinnedQty: opts.pinnedQty,
  });
  // Unpriced => leave the draft's own quantity untouched (behaviour before sizing existed).
  if (d.ok && d.qty > 0 && d.basis !== 'unpriced') draft.qty = d.qty;
  return { ...d, effective };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
