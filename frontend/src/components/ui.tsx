import React from 'react';

export function Card({ title, children, right }: { title?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="card">
      {title && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>{title}</h3>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Badge({ kind = 'gray', children }: { kind?: string; children: React.ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

/** Which ACCOUNT's fleet is on screen. Bots, orders, P/L and the journal all belong to
 *  the active trading environment, so the list changes when you switch accounts. */
export function FleetBadge({ env }: { env?: string }) {
  if (!env) return null;
  const paper = env === 'alpaca_paper';
  return <Badge kind={paper ? 'gray' : 'amber'}>{paper ? 'Paper fleet (Alpaca)' : 'Robinhood fleet'}</Badge>;
}

export function money(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
export function num(v: any, d = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}
export function pct(v: any): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
}
export function signClass(v: any): string {
  const n = Number(v);
  return n > 0 ? 'green' : n < 0 ? 'red' : 'muted';
}

/** Current per-unit price of a position: prefer the backend's live last_price; else
 *  derive from market value — options trade in 100-share contracts (÷ qty×100). */
export function posLast(p: any): number | null {
  if (p?.last_price != null && Number.isFinite(Number(p.last_price))) return Number(p.last_price);
  const qty = Number(p?.qty);
  if (!qty) return null;
  const mult = (p?.asset_class === 'option') ? 100 : 1;
  const mv = Number(p?.market_value);
  return Number.isFinite(mv) ? mv / (qty * mult) : null;
}

/** Pacific-time datetime, matching the market clock — use everywhere timestamps show. */
export function fmtDateTime(v: any): string {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
}

/** A clickable ticker chip that deep-links to the ticker detail hub. Use this
 *  anywhere a symbol appears so positions/bots/orders/watchlist all navigate
 *  to the same fine-grained per-symbol page. */
export function Sym({ children, bold }: { children: React.ReactNode; bold?: boolean }) {
  const s = String(children || '').toUpperCase();
  if (!s) return <>—</>;
  return (
    <a className="symlink" href={`#/ticker/${s}`} title={`Open ${s} detail`} style={bold ? { fontWeight: 700 } : undefined}>
      {s}
    </a>
  );
}

/** An info icon with a hover/click tooltip. Pass `topic` to pull from the docs
 *  registry, or `text` for inline copy. Explains what a tool/finding does and how
 *  to leverage it — sprinkled across the app. */
export function Info({ topic, text }: { topic?: string; text?: string }) {
  const [open, setOpen] = React.useState(false);
  const body = text || (topic ? DOCS[topic] : '') || '';
  if (!body) return null;
  return (
    <span className="info-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="info-i" aria-label="More info" aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>i</button>
      {open && <span className="info-pop" role="tooltip">{body}</span>}
    </span>
  );
}

/** Central documentation: what each tool/finding means and how to use it. */
export const DOCS: Record<string, string> = {
  campaign: 'The Growth Plan tracks a high-risk $1k→$100k push on your Robinhood agentic account. It tracks equity daily vs. an exponential "on-track" curve, tells you which phase you\'re in, and tightens risk as the account grows. Use the per-phase "Set up →" buttons to create the bots for your current size.',
  pace: 'Your current account value vs. where the exponential start→goal curve says you "should" be today. Ahead = bank profits and protect the lead; behind = wait for an A+ setup, don\'t chase with bigger size.',
  phase: 'The campaign has 4 phases keyed to account size. Each caps risk-per-trade, max open positions, and stop/scale levels. As you grow, risk-per-trade % drops — that\'s how you avoid giving it all back.',
  account_multiple: 'How many times the strategy would have multiplied the WHOLE account over the window if you reinvested everything each trade (compounded). 10× = turned $1k into $10k. This is the headline "would it have 10x–100x\'d me" number — and it assumes max aggression, so treat it as an upper bound.',
  best_multiple: 'The single best trade\'s payoff multiple in the window (e.g. 8× = one trade returned 700%). High best-multiple with low account-multiple means one lucky trade, not a repeatable edge.',
  seasonal_fit: 'How well a strategy fits the CURRENT regime (hawkish Fed, AI/memory + power/energy/defense tailwinds, midterm Q3 drawdown → Q4 rally) — not just how it backtested. "Seasonal-fit" = aligned now; "regime-caution" = it worked in a different environment, be careful. Filters out backtest winners that won\'t repeat.',
  scan: 'Backtests every bot over the last 6 months, prices option bots with REAL historical option chains, ranks by compounded account multiple, and badges the 10×–100× performers + their current-regime fit. This is how you find which bots would have grown the account — and which still make sense now.',
  greeks: 'Δ (delta) ≈ how much the option moves per $1 of stock (also a rough probability of finishing in-the-money). IV (implied volatility) is the market\'s expected move — high IV = expensive options and bigger post-event "crush". Into known events, prefer debit spreads to blunt IV crush.',
  alerts: 'Muse watches SPY, META, TSLA, and QQQ on a short loop and writes notes. Groq still sorts incoming news cheaply; longer takes go NVIDIA then Groq, with Muse as backup. None of those loops place an order in Observe.',
  watcher: 'The desk watcher is a timed loop on SPY, META, TSLA, and QQQ. It refreshes news, reads simple indicators (trend, RSI, distance from high), asks Muse for a short take, and writes alerts plus learnings. Observe only: no orders, even if the global mode is higher. Change the list with WATCH_UNIVERSE in .env.',
  muse: 'Muse Spark (Meta Model API, PAYG Standard muse-spark-1.3) is the first-class ops model. It leads chat, watch, performance, and agent tasks. Green lamp means a key is set and the last /models probe succeeded. The progress panel shows the current call, last watch cycle, last news pass, and sanitized errors. No secrets in that JSON.',
  providers: 'Ask AI chat leads with Muse when the key is live; Groq is the fallback. News triage stays Groq-first. Research, review, and ideas lead with NVIDIA, then Groq, with Muse as backup. Watch, performance, and agent lead with Muse. Kimi is backup. Anthropic stays on the chain but the key may be invalid.',
  itm: 'Shaded rows are in-the-money (calls below spot / puts above spot) — more expensive, higher delta, less leverage. Out-of-the-money is cheaper with more torque but lower odds.',
  monitors: 'Live trailing-stop / take-profit / stop-loss enforcement on open bot positions, checked every 45s during market hours. This is what actually closes a trade at your stop so a winner doesn\'t round-trip to a loss.',
  skew: 'The system trades for POSITIVE SKEW — small losses, big wins. A fixed, SMALL stop cuts losers fast; there is NO take-profit cap, so winners ride a trailing stop and run as far as the move goes. This deliberately accepts a sub-50% win rate: the math wins because the average win is ~3× the average loss. Backtested: ~38% win rate, ~3:1 payoff, profit factor >2. Tune each bot\'s stop & trailing-stop in its Edit panel.',
  mode: 'Observe = log only (no orders). Cautious = every order staged for your one-click approval. Auto = bots execute when rules and risk pass. Full-Auto = bots execute with the soft sizing caps off (position, concentration, orders-per-day no longer veto, still shown); only the kill switch, daily-loss breaker, and no-crypto / long-only still apply.',
  env: 'Paper (Alpaca) is fake money and real data. Observe is the mode that never sends an order. Live (Robinhood) trades a real agentic account. Switching swaps the whole portfolio view. Kill switch and risk limits apply in both.',
  pnl: 'Account profit/loss over Day, Week, Month, 90 days, and Year-to-date — computed from your broker\'s REAL equity history (Alpaca). "Day" is vs the prior session close (the same number your brokerage shows); the longer windows compare your live equity to the recorded equity at the start of each period. Robinhood\'s agentic account shows nothing here until it\'s funded and has history.',
  quickbot: 'QuickBots are single-ticker (or tight-basket) short-DTE options bots. Each trades 2–7 day CALLS when bullish signals fire and PUTS when bearish ones do, sized for POSITIVE SKEW: a small fixed stop cuts losers, and there is NO take-profit cap — winners ride a trailing stop and run. Risk scales by days-to-expiry (tighter stop + smaller size on 1–2 day, more room on 7-day). Plays are chosen empirically from a 1-year backtest by EXPECTANCY (not win rate), and their custom risk OVERRIDES the global limits. Ship in Cautious mode (orders staged for approval) — flip to Auto when you trust them.',
  quickbot_bt: 'Searches every entry-signal × DTE combination over the last year on REAL underlying price action, pricing each option with Black–Scholes repriced along the path (captures gamma upside + theta decay). Exits use the play\'s take-profit / stop-loss / trailing-stop on the option premium, capped at expiry. "Total ($1k)" is fixed-stake (you risk a set amount per trade, never compounding the whole account into one option). Profit factor = gross wins ÷ gross losses (>1 is profitable). Modeled — exact historical short-DTE fills aren\'t sourceable — so it RANKS strategies rather than promising fills.',
};

/** A small pulsing "LIVE" indicator — signals data is streaming, not static. */
export function Live({ label = 'LIVE' }: { label?: string }) {
  return <span className="live-pill" title="Updating automatically — no refresh needed"><span className="live-dot" />{label}</span>;
}

/** Thin progress bar (0–100%). */
export function Progress({ value, kind = 'green' }: { value: number; kind?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="progress">
      <div className={`progress-fill ${kind}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export function statusBadge(s: string) {
  const map: Record<string, string> = {
    placed: 'green', filled: 'green', approved: 'green', allow: 'green',
    vetoed: 'red', rejected: 'red', canceled: 'red', veto: 'red',
    staged: 'amber', pending: 'amber',
    draft: 'blue', observe: 'blue',
  };
  return <Badge kind={map[s] || 'gray'}>{s}</Badge>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: any[] = [], intervalMs?: number) {
  const [data, setData] = React.useState<T | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const run = React.useCallback(() => {
    fn()
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, deps);
  React.useEffect(() => {
    run();
    if (intervalMs) {
      // Don't poll while the tab is hidden — saves backend/RH/Alpaca load. Refresh
      // once on return to visibility so data is current when the user comes back.
      const iv = setInterval(() => { if (!document.hidden) run(); }, intervalMs);
      const onVis = () => { if (!document.hidden) run(); };
      document.addEventListener('visibilitychange', onVis);
      return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
    }
  }, [run, intervalMs]);
  return { data, err, loading, reload: run };
}
