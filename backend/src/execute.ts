import { exec, getGlobalMode, audit, getTradingEnv, q } from './db.js';
import type { Mode, TradingEnv } from './config.js';
import { decideExecution, logRiskEvent, type OrderDraft } from './risk/engine.js';
import { placeOrder as brokerPlace } from './brokers/index.js';
import { execObserveBlock } from './risk/observe.js';
import { releaseBuyNotional, reserveBuyNotional } from './risk/exposure.js';

export type ExecResult = {
  orderId: number;
  action: 'observe' | 'stage' | 'execute' | 'veto';
  status: string;
  reason: string;
  rh_order_id?: string;
  fillPrice?: number | null; // actual broker fill (when reported) — used to record real exit prices
  risk: Awaited<ReturnType<typeof decideExecution>>['risk'];
};

/** For options, resolve the CONCRETE contract (buy AND sell) so the risk engine sizes on
 *  the real per-contract premium (×100) and a SELL is matched to the exact held contract
 *  (occ_symbol) — not just any contract on the underlying. Idempotent: a draft that already
 *  carries `_contract` is left alone, so resolving early (to size a bot order off the real
 *  premium) never causes a second lookup or a different contract at execution time. */
export async function resolveDraftContract(draft: OrderDraft, env: TradingEnv): Promise<void> {
  if ((draft.asset_class || '').toLowerCase() !== 'option' || !draft.option_type || draft._contract) return;
  try {
    const { resolveContract, resolveContractRH } = await import('./brokers/options.js');
    const { brokerKind } = await import('./brokers/index.js');
    // Live Robinhood → resolve against RH's OWN chain so the contract is guaranteed
    // tradable there (nearest listed strike/expiry). Alpaca/paper → Alpaca chain.
    const c = brokerKind(env) === 'robinhood'
      ? await resolveContractRH(draft.symbol, draft.option_type, draft.strike_target || 'atm', draft.expiration || 'monthly')
      : await resolveContract(draft.symbol, draft.option_type, draft.strike_target || 'atm', draft.expiration || 'monthly');
    if (c) {
      draft._contract = { occSymbol: c.occSymbol, type: c.type, strike: c.strike, expiration: c.expiration, mid: c.mid, readable: c.readable, instrumentId: c.instrumentId };
      if (!(Number(draft.est_price) > 0) && (c.mid || c.ask)) draft.est_price = Number(c.mid ?? c.ask);
    }
  } catch { /* unresolved → risk vetoes the unpriceable buy / unmatched sell */ }
}

/**
 * The single chokepoint for ALL order intents (manual, bot, or AI).
 * Nothing reaches Robinhood except through here.
 */
export async function executeDraft(
  draft: OrderDraft,
  opts: { modeOverride?: Mode; rationale?: string } = {},
): Promise<ExecResult> {
  const mode = opts.modeOverride ?? (await getGlobalMode());
  // Resolve env ONCE and thread it through risk → placement so a concurrent
  // env switch can't evaluate risk for one env and place against another.
  const env = await getTradingEnv();
  // A draft built for one account must never execute against another (env flipped
  // mid bot-cycle / mid monitor-cycle). Fail closed before risk or placement. (CP2 gate)
  if (draft.env && draft.env !== env) {
    await audit('order.env_mismatch', `draft for ${draft.env} refused: active env is ${env} (${draft.side} ${draft.qty} ${draft.symbol})`, { bot_id: draft.bot_id ?? null });
    throw new Error(`account switched mid-cycle: draft for ${draft.env} but active env is ${env} — order NOT placed`);
  }

  await resolveDraftContract(draft, env);

  // Observe-only stubs never create an order row — even when enabled=1 and mode=auto.
  // Re-read the bot so a missing draft._observe_only cannot bypass the gate.
  let botRow: { name?: any; action?: any; rules?: any; risk?: any; mode?: any } | null = null;
  if (draft.bot_id) {
    const rows = await q<any>('SELECT name, action, rules, risk, mode FROM bots WHERE id=:id AND env=:env', {
      id: draft.bot_id, env,
    });
    botRow = rows[0] || null;
  }
  const og = execObserveBlock(draft, botRow);
  if (og.blocked) {
    await audit('order.observe_only', `${draft.side} ${draft.qty} ${draft.symbol} blocked — observe-only stub`, {
      bot_id: draft.bot_id ?? null, env, reason: og.reason,
    });
    return {
      orderId: 0,
      action: 'observe',
      status: 'observe_only',
      reason: og.reason,
      risk: {
        ok: true,
        reason: og.reason,
        checks: { observe_only: { pass: true, detail: og.reason } },
        computed: {},
      },
    };
  }

  const decision = await decideExecution(draft, mode, env);
  await logRiskEvent(draft, decision.risk);

  // Reserve only after a passing buy so the next bot in this cycle sees the
  // notional without double-counting this ticket inside riskCheck.
  const ac = (draft.asset_class || 'equity').toLowerCase();
  const px = Number(draft.est_price ?? draft.limit_price) || 0;
  const reserveUsd = draft.side === 'buy'
    && (decision.action === 'execute' || decision.action === 'stage')
    && px > 0
    ? px * Number(draft.qty || 0) * (ac === 'option' ? 100 : 1)
    : 0;
  if (reserveUsd > 0) reserveBuyNotional(env, draft.symbol, reserveUsd);

  try {
  const statusByAction: Record<string, string> = {
    veto: 'vetoed',
    observe: 'draft',
    stage: 'staged',
    execute: 'placed',
  };
  let status = statusByAction[decision.action];
  let rhOrderId: string | undefined;
  let placeRaw: any = null;
  let fillPrice: number | null = null;

  // Insert the order record first (audit even for vetoes / observe).
  const ins = await exec(
    `INSERT INTO orders
      (env, symbol, asset_class, side, qty, order_type, limit_price, stop_price, status,
       source, bot_id, mode, risk_decision, risk_reason, rationale, raw)
     VALUES
      (:env,:symbol,:asset_class,:side,:qty,:order_type,:limit_price,:stop_price,:status,
       :source,:bot_id,:mode,:risk_decision,:risk_reason,:rationale,CAST(:raw AS JSON))`,
    {
      env,
      symbol: draft.symbol,
      asset_class: draft.asset_class || 'equity',
      side: draft.side,
      qty: draft.qty,
      order_type: draft.order_type || 'market',
      limit_price: draft.limit_price ?? null,
      stop_price: draft.stop_price ?? null,
      status,
      source: draft.source || 'manual',
      bot_id: draft.bot_id ?? null,
      mode,
      risk_decision: decision.risk.ok ? 'allow' : 'veto',
      risk_reason: decision.risk.reason,
      rationale: opts.rationale ?? null,
      raw: JSON.stringify({ draft, decision }),
    },
  );
  const orderId = ins.insertId;

  if (decision.action === 'stage') {
    await exec(
      `INSERT INTO approvals (order_id, symbol, side, qty, draft)
       VALUES (:order_id,:symbol,:side,:qty,CAST(:draft AS JSON))`,
      {
        order_id: orderId,
        symbol: draft.symbol,
        side: draft.side,
        qty: draft.qty,
        draft: JSON.stringify(draft),
      },
    );
  }

  if (decision.action === 'execute') {
    try {
      const res = await brokerPlace(draft, env);
      placeRaw = res.raw;
      rhOrderId = res.rhOrderId;
      status = 'placed';
      // Capture the actual fill if the broker reported one (Alpaca market orders fill
      // immediately with filled_avg_price; RH fills async so this may be null at place time).
      const reportedFill = Number(placeRaw?.filled_avg_price ?? placeRaw?.filled_price ?? placeRaw?.price);
      if (Number.isFinite(reportedFill) && reportedFill > 0) fillPrice = reportedFill;
      const reportedQty = Number(placeRaw?.filled_qty);
      await exec('UPDATE orders SET status=:s, rh_order_id=:rid, filled_price=:fp, filled_qty=COALESCE(:fq, filled_qty), raw=CAST(:raw AS JSON) WHERE id=:id', {
        s: status,
        rid: rhOrderId ?? null,
        fp: fillPrice,
        fq: Number.isFinite(reportedQty) && reportedQty > 0 ? reportedQty : null,
        raw: JSON.stringify({ draft, decision, place: placeRaw }),
        id: orderId,
      });
      // Open a live monitor for bot/AI BUYs so TP/SL/trailing get enforced.
      if (draft.side === 'buy' && (draft.source === 'bot' || draft.source === 'ai')) {
        // ?? doesn't catch NaN; Number(undefined)=NaN — coerce then ||0.
        const entry = Number(draft.est_price ?? placeRaw?.filled_avg_price) || 0;
        const { createMonitor } = await import('./risk/monitor.js');
        await createMonitor(draft, orderId, entry, env).catch(() => {});
      }
    } catch (err: any) {
      status = 'rejected';
      await exec('UPDATE orders SET status=:s, risk_reason=:r WHERE id=:id', {
        s: status,
        r: 'placement error: ' + (err?.message || String(err)),
        id: orderId,
      });
      await audit('order.error', `place failed for ${draft.symbol}`, { err: err?.message });
    }
  }

  await audit('order.' + decision.action, `${draft.side} ${draft.qty} ${draft.symbol} → ${status}`, {
    orderId,
    mode,
    env,
    risk: decision.risk.reason,
  });

  return { orderId, action: decision.action, status, reason: decision.risk.reason, rh_order_id: rhOrderId, fillPrice, risk: decision.risk };
  } finally {
    if (reserveUsd > 0) releaseBuyNotional(env, draft.symbol, reserveUsd);
  }
}

/** Approve a staged order (cautious mode) → execute it now. */
export async function approveOrder(approvalId: number): Promise<ExecResult | null> {
  const rows = await (await import('./db.js')).q<any>(
    "SELECT * FROM approvals WHERE id=:id AND status='pending'",
    { id: approvalId },
  );
  if (!rows.length) return null;
  const appr = rows[0];
  const draft: OrderDraft = JSON.parse(typeof appr.draft === 'string' ? appr.draft : JSON.stringify(appr.draft));
  await exec("UPDATE approvals SET status='approved', decided_at=NOW() WHERE id=:id", { id: approvalId });
  // Force execute (bypass staging) now that a human approved.
  return executeDraft(draft, { modeOverride: 'auto', rationale: 'approved from cautious queue' });
}

export async function rejectOrder(approvalId: number): Promise<void> {
  await exec("UPDATE approvals SET status='rejected', decided_at=NOW() WHERE id=:id", { id: approvalId });
  await exec(
    "UPDATE orders SET status='canceled' WHERE id=(SELECT order_id FROM approvals WHERE id=:id)",
    { id: approvalId },
  );
}
