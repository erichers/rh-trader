import { q, exec, getSetting, setSetting, getTradingEnv } from './db.js';
import type { TradingEnv } from './config.js';

// Real-time operational alerting. The Groq→Kimi NEWS pipeline already writes 'news'/'groq'/'kimi'
// alerts into the same table; THIS engine adds trading-operations alerts — order fills, stop/TP
// exits, FAILED exits (critical), intraday drawdown breaches, and kill-switch changes. It runs on
// a short worker loop off a durable cursor (so each fill/exit alerts exactly once) plus event hooks.

export type AlertRules = {
  fills: boolean; exits: boolean; exit_failed: boolean; drawdown: boolean; kill_switch: boolean;
  drawdown_pct: number; // intraday peak-to-current equity drop that trips a drawdown alert
};
const DEFAULT_RULES: AlertRules = { fills: true, exits: true, exit_failed: true, drawdown: true, kill_switch: true, drawdown_pct: 5 };

export async function getAlertRules(): Promise<AlertRules> {
  const o = await getSetting<Partial<AlertRules>>('alert_rules', {});
  const b = (v: any, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    fills: b(o?.fills, true), exits: b(o?.exits, true), exit_failed: b(o?.exit_failed, true),
    drawdown: b(o?.drawdown, true), kill_switch: b(o?.kill_switch, true),
    drawdown_pct: Number.isFinite(Number(o?.drawdown_pct)) && Number(o?.drawdown_pct) > 0 ? Math.min(50, Math.max(1, Number(o?.drawdown_pct))) : DEFAULT_RULES.drawdown_pct,
  };
}
export async function setAlertRules(next: Partial<AlertRules>): Promise<AlertRules> {
  const cur = await getAlertRules();
  await setSetting('alert_rules', { ...cur, ...next });
  return getAlertRules();
}

/** Insert an alert, de-duplicated: an identical (source,title) within `dedupMin` minutes is skipped
 *  so a level-triggered condition (e.g. drawdown) doesn't spam every cycle. Returns the new id or null. */
export async function raiseAlert(a: {
  level?: 'info' | 'warn' | 'critical'; source?: string; title: string; body?: string;
  symbol?: string | null; direction?: string | null; bot_ids?: number[] | null; dedupMin?: number;
}): Promise<number | null> {
  const dedupMin = a.dedupMin ?? 5;
  const [dup] = await q<{ n: number }>(
    'SELECT COUNT(*) n FROM alerts WHERE source=:s AND title=:t AND created_at > (NOW() - INTERVAL :m MINUTE)',
    { s: a.source || 'system', t: a.title, m: dedupMin },
  );
  if (Number(dup?.n)) return null;
  const res = await exec(
    `INSERT INTO alerts (level, source, title, body, symbol, direction, bot_ids, status)
     VALUES (:level,:source,:title,:body,:symbol,:direction,CAST(:bots AS JSON),'new')`,
    {
      level: a.level || 'info', source: a.source || 'system', title: a.title.slice(0, 250), body: a.body || null,
      symbol: a.symbol || null, direction: a.direction || null, bots: JSON.stringify(a.bot_ids || null),
    },
  );
  return res.insertId;
}

/** Kill-switch toggled — raise immediately from the route handler. */
export async function alertKillSwitch(on: boolean): Promise<void> {
  if (!(await getAlertRules()).kill_switch) return;
  await raiseAlert({
    level: on ? 'critical' : 'info', source: 'risk',
    title: on ? '● KILL SWITCH ENGAGED' : 'Kill switch released',
    body: on ? 'New BUY orders are blocked. Protective exits (sells/stops) still run.' : 'Bots can place new orders again (subject to mode + risk limits).',
    dedupMin: 0,
  });
}

function r2(n: number, d = 2): number { const f = 10 ** d; return Number.isFinite(n) ? Math.round(n * f) / f : 0; }

/** Worker loop body: emit alerts for new fills / exits / failed exits + intraday drawdown.
 *  Off a durable cursor so each order/monitor alerts exactly once across restarts. */
export async function runAlertEngine(): Promise<{ raised: number }> {
  const rules = await getAlertRules();
  const env = await getTradingEnv();
  const cursor = await getSetting<{ lastOrderId: number; lastClosedMonitorId: number; lastFailKey?: string }>(
    'alert_cursor', { lastOrderId: 0, lastClosedMonitorId: 0 },
  );
  let raised = 0;
  let maxOrderId = cursor.lastOrderId || 0;
  let maxClosedMon = cursor.lastClosedMonitorId || 0;

  // ── New order fills (placed/filled) since the cursor ──────────────────────
  if (rules.fills) {
    const fills = await q<any>(
      "SELECT id, symbol, side, qty, asset_class, status, source, bot_id FROM orders WHERE env=:env AND id>:c AND status IN ('placed','filled') ORDER BY id ASC LIMIT 50",
      { env, c: cursor.lastOrderId || 0 },
    );
    for (const o of fills) {
      await raiseAlert({
        level: 'info', source: 'order',
        title: `Order ${o.status}: ${o.side.toUpperCase()} ${r2(Number(o.qty), 2)} ${o.symbol}`,
        body: `${o.asset_class} · ${o.source}${o.bot_id ? ` · bot #${o.bot_id}` : ''}`,
        symbol: o.symbol, direction: o.side, bot_ids: o.bot_id ? [o.bot_id] : null, dedupMin: 0,
      });
      raised++; maxOrderId = Math.max(maxOrderId, o.id);
    }
  } else {
    const [mx] = await q<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM orders WHERE env=:env', { env });
    maxOrderId = Math.max(maxOrderId, Number(mx?.m) || 0); // advance cursor even when muted
  }

  // ── Exits: monitors closed since the cursor (stop / take-profit / trailing / flatten) ──
  if (rules.exits) {
    const exits = await q<any>(
      "SELECT id, symbol, occ_symbol, asset_class, reason, entry_price, exit_price, last_price, qty, bot_id FROM position_monitors WHERE status='closed' AND id>:c AND (env=:env OR (env IS NULL AND :env='alpaca_paper')) ORDER BY id ASC LIMIT 50",
      { env, c: cursor.lastClosedMonitorId || 0 },
    );
    for (const m of exits) {
      const entry = Number(m.entry_price) || 0; const exit = Number(m.exit_price) || Number(m.last_price) || 0;
      const pct = entry > 0 ? r2(((exit - entry) / entry) * 100, 1) : 0;
      const win = pct >= 0;
      await raiseAlert({
        level: win ? 'info' : 'warn', source: 'monitor',
        title: `Exit (${m.reason || 'closed'}): ${m.symbol} ${pct >= 0 ? '+' : ''}${pct}%`,
        body: `Closed ${m.occ_symbol || m.symbol} — entry ${r2(entry, 4)} → exit ${r2(exit, 4)}.`,
        symbol: m.symbol, bot_ids: m.bot_id ? [m.bot_id] : null, dedupMin: 0,
      });
      raised++; maxClosedMon = Math.max(maxClosedMon, m.id);
    }
  } else {
    const [mx] = await q<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM position_monitors WHERE status='closed'");
    maxClosedMon = Math.max(maxClosedMon, Number(mx?.m) || 0);
  }

  // ── Failed exits (a stop that could NOT be placed — position still unprotected) ──
  if (rules.exit_failed) {
    const failed = await q<any>(
      "SELECT id, symbol, reason FROM position_monitors WHERE status='open' AND reason LIKE 'EXIT FAILED%' AND (env=:env OR (env IS NULL AND :env='alpaca_paper'))",
      { env },
    );
    for (const m of failed) {
      const id = await raiseAlert({
        level: 'critical', source: 'monitor',
        title: `EXIT FAILED: ${m.symbol} still open`,
        body: `${m.reason}. The monitor will keep retrying every cycle, but the position is unprotected until it fills.`,
        symbol: m.symbol, dedupMin: 30,
      });
      if (id) raised++;
    }
  }

  // ── Intraday drawdown breach (peak-to-current equity), cheap off the accounts table ──
  if (rules.drawdown) {
    const acct = (await q<any>('SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env }))[0];
    const equity = Number(acct?.equity) || 0;
    if (equity > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const hwm = await getSetting<{ date: string; peak: number; env: string }>('equity_hwm', { date: '', peak: 0, env: '' });
      let peak = (hwm.date === today && hwm.env === env) ? Number(hwm.peak) || equity : equity;
      peak = Math.max(peak, equity);
      await setSetting('equity_hwm', { date: today, peak, env });
      const dd = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
      if (dd <= -rules.drawdown_pct) {
        const id = await raiseAlert({
          level: 'critical', source: 'risk',
          title: `Drawdown breach: ${r2(dd, 1)}% from today's peak`,
          body: `Equity ${r2(equity)} is down ${r2(Math.abs(dd), 1)}% from today's high of ${r2(peak)} (threshold ${rules.drawdown_pct}%). Consider the kill switch or de-risking.`,
          dedupMin: 60,
        });
        if (id) raised++;
      }
    }
  }

  await setSetting('alert_cursor', { lastOrderId: maxOrderId, lastClosedMonitorId: maxClosedMon });
  return { raised };
}
