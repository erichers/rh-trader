import { q, exec, audit, getTradingEnv } from './db.js';
import { BREAKEVEN_ARM_PCT, RATCHET_1, RATCHET_2 } from './risk/exitpolicy.js';
import { raiseAlert } from './alerts.js';
import type { TradingEnv } from './config.js';

// Trade forensics + data-driven tuning. Every number comes from REAL round-trips
// (position_monitors carry entry, peak = max favorable, trough = max adverse, the actual
// exit and its reason). Per-trade: what happened + a concrete suggested improvement.
// Per-bot: performance rollup + a recommended stop/trail derived from that bot's own
// realized peak/giveback/loss distribution — honest about sample size (small n = low
// confidence = keep current settings).

function r1(n: number): number { return Math.round(n * 10) / 10; }
function median(a: number[]): number { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function parse(v: any): any { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

export type TradeRow = {
  id: number; symbol: string; occ_symbol: string | null; asset_class: string; status: string;
  bot_id: number | null; bot_name: string; entry: number; exit: number | null; exit_is_fill: boolean;
  pl_pct: number; peak_pct: number; trough_pct: number | null; giveback_pct: number | null;
  hold_min: number | null; reason: string | null; opened_at: any; closed_at: any;
  sl_pct: number; trail_pct: number; tp_pct: number;
  verdict: 'win' | 'loss' | 'open'; suggestion: string;
};

/** Plain-spoken per-trade read: what the exit did, and what (if anything) should change.
 *  References the ratchet/breakeven upgrades where they would have altered the outcome. */
function suggestFor(t: { pl: number; peak: number; reason: string; status: string; sl: number; trail: number; tp: number }): string {
  const { pl, peak, reason, status } = t;
  if (status === 'open') return `Open — managed live (stop −${t.sl}%, trail ${t.trail}pts${t.tp > 0 ? `, cap +${t.tp}%` : ', no cap'}).`;
  const giveback = peak - pl;
  if (reason === 'breakeven-lock') return `Round-trip prevented: peaked +${r1(peak)}% and the breakeven lock closed it at ~+1% instead of a loss.`;
  if (reason === 'take-profit') return `Capped at +${r1(pl)}% by a take-profit. TP caps are now OFF by default — this setup now rides the ratchet trail instead (a +${r1(peak)}% peak would have kept running).`;
  if (pl < 0 && peak >= BREAKEVEN_ARM_PCT) return `Was up +${r1(peak)}% but closed ${r1(pl)}%. The breakeven lock (live now) makes this impossible going forward — a +${BREAKEVEN_ARM_PCT}% trade can no longer close negative.`;
  if (pl < 0 && (reason === 'stop-loss' || reason === 'trailing-stop') && peak < 12) return `Clean cut: thesis failed fast (peaked only +${r1(peak)}%), exited ${r1(pl)}%. This is the "small loss" half of the design — keep it.`;
  if (pl < 0 && reason === 'expiry') return `Held to expiry for ${r1(pl)}% — theta ate it. The stop should have acted earlier; verify the monitor covered this position all session.`;
  if (pl < 0 && String(reason).startsWith('flatten')) return `EOD flatten cut a fading position at ${r1(pl)}% instead of carrying overnight gap risk. Working as designed.`;
  if (pl < 0) return `Loss ${r1(pl)}% (peak +${r1(peak)}%). Within the small-loss budget (stop −${t.sl}%).`;
  if (String(reason).startsWith('flatten')) return `EOD flatten banked +${r1(pl)}% (peaked +${r1(peak)}%) before overnight gap risk — good exit.`;
  if (reason === 'trailing-stop' && giveback > 42) return `Rode to +${r1(peak)}% but gave back ${r1(giveback)}pts to the trail. The ratchet (live now) tightens the trail to ${RATCHET_1.trail}pts after +${RATCHET_1.at}% and ${RATCHET_2.trail}pts after +${RATCHET_2.at}% — this exit improves to ~+${r1(Math.max(pl, peak - (peak >= RATCHET_2.at ? RATCHET_2.trail : peak >= RATCHET_1.at ? RATCHET_1.trail : t.trail)))}%.`;
  if (reason === 'trailing-stop') return `Rode to +${r1(peak)}%, exited +${r1(pl)}% on the trail (${r1(giveback)}pts giveback) — the asymmetric profile doing its job.`;
  return `Closed +${r1(pl)}% (peak +${r1(peak)}%, ${reason || 'exit'}).`;
}

export async function tradeAnalysis(opts: { days?: number; envArg?: TradingEnv } = {}): Promise<any> {
  const env = opts.envArg ?? (await getTradingEnv());
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const mons = await q<any>(
    `SELECT m.*, b.name AS bot_name, b.risk AS bot_risk, b.asset_class AS bot_ac,
            JSON_EXTRACT(b.action,'$._quickbot') AS is_qb
       FROM position_monitors m LEFT JOIN bots b ON b.id=m.bot_id
      WHERE (m.env=:env OR (m.env IS NULL AND :env='alpaca_paper'))
        AND m.opened_at >= CURDATE() - INTERVAL :days DAY
      ORDER BY m.opened_at ASC`, { env, days },
  );

  const trades: TradeRow[] = mons.map((m: any) => {
    const entry = Number(m.entry_price) || 0;
    const exitP = m.status === 'closed' ? (Number(m.exit_price) > 0 ? Number(m.exit_price) : Number(m.last_price)) : Number(m.last_price);
    const pl = entry > 0 ? ((exitP - entry) / entry) * 100 : 0;
    const peak = entry > 0 ? ((Number(m.peak_price) - entry) / entry) * 100 : 0;
    const trough = entry > 0 && Number(m.trough_price) > 0 ? ((Number(m.trough_price) - entry) / entry) * 100 : null;
    const hold = m.opened_at ? Math.round((((m.closed_at ? Date.parse(m.closed_at) : Date.now()) - Date.parse(m.opened_at)) / 60000)) : null;
    const sl = Number(m.sl_pct) || 0, trail = Number(m.trail_pct) || 0, tp = Number(m.tp_pct) || 0;
    const row: TradeRow = {
      id: m.id, symbol: m.symbol, occ_symbol: m.occ_symbol || null, asset_class: m.asset_class, status: m.status,
      bot_id: m.bot_id, bot_name: m.bot_name || (m.bot_id ? `bot #${m.bot_id}` : 'AI/manual'),
      entry: r1(entry * 100) / 100, exit: m.status === 'closed' ? Math.round(exitP * 10000) / 10000 : null,
      exit_is_fill: m.exit_price != null, pl_pct: r1(pl), peak_pct: r1(peak), trough_pct: trough != null ? r1(trough) : null,
      giveback_pct: m.status === 'closed' ? r1(peak - pl) : null, hold_min: hold, reason: m.reason || null,
      opened_at: m.opened_at, closed_at: m.closed_at, sl_pct: sl, trail_pct: trail, tp_pct: tp,
      verdict: m.status !== 'closed' ? 'open' : pl > 0 ? 'win' : 'loss',
      suggestion: suggestFor({ pl, peak, reason: m.reason || '', status: m.status, sl, trail, tp }),
    };
    return row;
  });

  // ── Per-day P/L ────────────────────────────────────────────────────────────
  const byDay: Record<string, { date: string; n: number; wins: number; pl_sum: number }> = {};
  for (const t of trades) {
    if (t.verdict === 'open') continue;
    const d = new Date(t.closed_at || t.opened_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    (byDay[d] ||= { date: d, n: 0, wins: 0, pl_sum: 0 });
    byDay[d].n++; if (t.verdict === 'win') byDay[d].wins++; byDay[d].pl_sum = r1(byDay[d].pl_sum + t.pl_pct);
  }

  // ── Per-bot rollup + recommendation ───────────────────────────────────────
  const botIds = Array.from(new Set(trades.map((t) => t.bot_id).filter(Boolean))) as number[];
  const bots: any[] = [];
  for (const bid of botIds) {
    const rows = trades.filter((t) => t.bot_id === bid && t.verdict !== 'open');
    const meta = mons.find((m: any) => m.bot_id === bid);
    const riskCfg = parse(meta?.bot_risk) || {};
    const isQb = meta?.is_qb === true || meta?.is_qb === 'true';
    const wins = rows.filter((t) => t.pl_pct > 0), losses = rows.filter((t) => t.pl_pct <= 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pl_pct, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pl_pct, 0) / losses.length) : 0;
    const total = rows.reduce((s, t) => s + t.pl_pct, 0);
    const reasons: Record<string, number> = {};
    for (const t of rows) reasons[t.reason || 'other'] = (reasons[t.reason || 'other'] || 0) + 1;
    // Current effective exits: quickbots carry per-play bands; others use risk fields.
    const curSl = rows.length ? median(rows.map((t) => t.sl_pct).filter((x) => x > 0)) : Number(riskCfg.stop_loss_pct) || 0;
    const curTrail = rows.length ? median(rows.map((t) => t.trail_pct).filter((x) => x > 0)) : Number(riskCfg.trailing_stop_pct) || 0;

    // Data-driven recommendation (conservative: move HALFWAY from current toward what the
    // realized distribution says, and only with a real sample).
    const rationale: string[] = [];
    let recSl = curSl, recTrail = curTrail;
    const n = rows.length;
    const confidence = n >= 12 ? 'high' : n >= 6 ? 'medium' : 'low';
    if (n >= 6) {
      // Stops: if losers die with tiny peaks, the stop can come in a bit (they were just wrong).
      // If several stop-outs had been up >15% first (whipsaw), the stop/trail pair is too tight.
      const cleanLosses = losses.filter((t) => t.peak_pct < 12).length;
      const whipsaws = losses.filter((t) => t.peak_pct >= 15).length;
      if (losses.length >= 3 && cleanLosses / losses.length >= 0.7 && curSl > 25) {
        recSl = Math.max(22, r1(curSl - (curSl - avgLoss * 0.85) / 2));
        rationale.push(`${cleanLosses}/${losses.length} losers never got above +12% (median loss −${r1(median(losses.map(l => Math.abs(l.pl_pct))))}%) — wrong-thesis trades die fast here, so the stop can tighten toward −${recSl}%.`);
      } else if (whipsaws >= 2) {
        recSl = Math.min(60, r1(curSl * 1.15));
        rationale.push(`${whipsaws} losers were up ≥15% before stopping out (whipsaw) — a slightly wider stop −${recSl}% + the breakeven lock handles these better.`);
      }
      // Trail: compare winners' giveback to their peaks. Ratchet already tightens big winners;
      // if the AVERAGE winner still gives back >60% of its peak, bring the base trail in.
      if (wins.length >= 3) {
        const gb = wins.map((t) => t.giveback_pct || 0);
        const pk = wins.map((t) => t.peak_pct);
        const gbShare = pk.reduce((s, p, i) => s + (p > 0 ? gb[i] / p : 0), 0) / wins.length;
        if (gbShare > 0.6 && curTrail > 28) {
          recTrail = Math.max(25, r1(curTrail - (curTrail - median(gb)) / 2));
          rationale.push(`Winners gave back ${Math.round(gbShare * 100)}% of their peaks on average (median giveback ${r1(median(gb))}pts) — base trail comes in toward ${recTrail}pts (ratchet still tightens further after +${RATCHET_1.at}%).`);
        } else {
          rationale.push(`Winner giveback is ${Math.round(gbShare * 100)}% of peak — acceptable for a let-it-run profile; base trail stays ${curTrail}pts.`);
        }
      }
      if (!rationale.length) rationale.push('Realized distribution matches current settings — no change supported by the data.');
    } else {
      rationale.push(`Only ${n} closed trade(s) in the window — not enough evidence to retune. Keeping backtest-derived settings.`);
    }

    bots.push({
      bot_id: bid, name: rows[0]?.bot_name || meta?.bot_name || `bot #${bid}`, is_quickbot: !!isQb,
      n, wins: wins.length, losses: losses.length,
      win_rate: n ? r1((wins.length / n) * 100) : 0,
      avg_win_pct: r1(avgWin), avg_loss_pct: r1(avgLoss),
      payoff: avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : (avgWin > 0 ? 99 : 0),
      expectancy_pct: n ? r1(total / n) : 0, total_pl_pct: r1(total),
      best_pct: n ? r1(Math.max(...rows.map((t) => t.pl_pct))) : 0,
      worst_pct: n ? r1(Math.min(...rows.map((t) => t.pl_pct))) : 0,
      median_peak_pct: r1(median(rows.map((t) => t.peak_pct))),
      exit_reasons: reasons,
      current: { sl: r1(curSl), trail: r1(curTrail) },
      recommend: { sl: r1(recSl), trail: r1(recTrail), changed: r1(recSl) !== r1(curSl) || r1(recTrail) !== r1(curTrail), confidence, rationale },
    });
  }
  bots.sort((a, b) => b.total_pl_pct - a.total_pl_pct);

  const closed = trades.filter((t) => t.verdict !== 'open');
  return {
    env, window_days: days, as_of: new Date().toISOString(),
    summary: {
      trades: closed.length, open: trades.length - closed.length,
      wins: closed.filter((t) => t.verdict === 'win').length,
      win_rate: closed.length ? r1((closed.filter((t) => t.verdict === 'win').length / closed.length) * 100) : 0,
      total_pl_pct: r1(closed.reduce((s, t) => s + t.pl_pct, 0)),
      avg_win_pct: r1((() => { const w = closed.filter((t) => t.pl_pct > 0); return w.length ? w.reduce((s, t) => s + t.pl_pct, 0) / w.length : 0; })()),
      avg_loss_pct: r1((() => { const l = closed.filter((t) => t.pl_pct <= 0); return l.length ? Math.abs(l.reduce((s, t) => s + t.pl_pct, 0) / l.length) : 0; })()),
    },
    daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    bots, trades: trades.reverse(), // newest first
    note: 'Every row is a real monitored round-trip: entry fill → actual exit (≈ marks a trigger price where the broker reported no fill). Peak = the best the trade ever looked; giveback = peak − realized. Suggestions reference the breakeven-lock + ratchet-trail upgrades now live in both the monitor and the backtest.',
  };
}

/** Apply per-bot recommended stop/trail from history. Dry-run by default; `apply` writes.
 *  QuickBots: updates every stored play's sl/trail (plays + symbol_plays). Others: risk fields. */
export async function tuneBots(opts: { days?: number; apply?: boolean } = {}): Promise<any> {
  const analysis = await tradeAnalysis({ days: opts.days ?? 14 });
  const applied: any[] = [];
  for (const b of analysis.bots) {
    const rec = b.recommend;
    const result: any = { bot_id: b.bot_id, name: b.name, n: b.n, confidence: rec.confidence, current: b.current, recommend: { sl: rec.sl, trail: rec.trail }, rationale: rec.rationale, changed: rec.changed, applied: false };
    if (opts.apply && rec.changed && rec.confidence !== 'low') {
      const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id: b.bot_id, env: await getTradingEnv() });
      if (bot) {
        const risk = parse(bot.risk) || {};
        risk.stop_loss_pct = rec.sl; risk.trailing_stop_pct = rec.trail; risk.take_profit_pct = 0;
        const action = parse(bot.action) || {};
        if (action._quickbot) {
          // QuickBot plays carry DTE-SCALED bands (tighter on 1-day, wider on 7-day). A flat
          // overwrite would destroy that structure — so apply the recommendation as a RATIO
          // (history says stops 15% wider / 15% tighter…) to every play, clamped to sane bounds.
          const slRatio = b.current.sl > 0 ? rec.sl / b.current.sl : 1;
          const trRatio = b.current.trail > 0 ? rec.trail / b.current.trail : 1;
          const clampPct = (v: number) => Math.min(70, Math.max(15, Math.round(v * 10) / 10));
          const retune = (plays: any[]) => (plays || []).map((p: any) => ({
            ...p,
            risk: { ...p.risk, sl: clampPct(Number(p.risk?.sl || 0) * slRatio), trail: clampPct(Number(p.risk?.trail || 0) * trRatio), tp: 0 },
          }));
          if (Array.isArray(action.plays)) action.plays = retune(action.plays);
          if (action.symbol_plays && typeof action.symbol_plays === 'object') {
            for (const s of Object.keys(action.symbol_plays)) action.symbol_plays[s] = retune(action.symbol_plays[s]);
          }
          result.quickbot_scaling = { sl_ratio: Math.round(slRatio * 100) / 100, trail_ratio: Math.round(trRatio * 100) / 100 };
        }
        await exec('UPDATE bots SET risk=CAST(:r AS JSON), action=CAST(:a AS JSON) WHERE id=:id AND env=:env', { r: JSON.stringify(risk), a: JSON.stringify(action), id: b.bot_id, env: bot.env });
        await audit('bot.tune', `history-tuned ${bot.name}: sl ${b.current.sl}→${rec.sl}, trail ${b.current.trail}→${rec.trail} (n=${b.n}, ${rec.confidence})`, { rationale: rec.rationale });
        await raiseAlert({ level: 'info', source: 'system', title: `Bot tuned from history: ${bot.name}`, body: `stop −${b.current.sl}%→−${rec.sl}%, trail ${b.current.trail}→${rec.trail}pts (${b.n} trades, ${rec.confidence} confidence).`, bot_ids: [b.bot_id], dedupMin: 0 });
        result.applied = true;
      }
    }
    applied.push(result);
  }
  // Also update open monitors' trail/stop? NO — never change stops on an already-open position
  // automatically (that silently widens live risk). New entries pick up the tuned values.
  return { window_days: analysis.window_days, apply: !!opts.apply, bots: applied, note: 'Recommendations move HALFWAY from current settings toward what the realized trade distribution supports, and only apply with ≥6 trades (medium/high confidence). Open positions keep their original stops — tuning affects new entries only.' };
}
