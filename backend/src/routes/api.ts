import type { FastifyInstance } from 'fastify';
import { config, MODES, TRADING_ENVS, isLiveEnv, type Mode, type TradingEnv } from '../config.js';
import { q, exec, ping, getGlobalMode, getKillSwitch, getTradingEnv, setTradingEnv, setSetting, audit, getRiskLimits, setRiskLimits, riskLimitDefaults, getExitPolicy, setExitPolicy, getTradeDefaults, setTradeDefaults, tradeDefaultsFactory } from '../db.js';
import { rh } from '../rh/mcpClient.js';
import { syncAll, brokerStatus } from '../brokers/index.js';
import { executeDraft, approveOrder, rejectOrder } from '../execute.js';
import { riskCheck, type OrderDraft } from '../risk/engine.js';
import { resolveBotRisk, resolveRiskWith, RISK_FIELDS, type RiskField } from '../risk/sizing.js';
import { STRATEGY_LIBRARY, seedStrategies } from '../bots/strategies.js';
import { evaluateBot, evaluateAllEnabledBots } from '../bots/engine.js';
import { analyzeSymbol, assistantChat, agentTradeTurn, aiReady, aiLabel, aiShort } from '../ai/claude.js';
import { TASKS, resolveChain, providerStatus, probeProviders, probedOnce } from '../ai/models.js';
import { backtestBot, backtest, scanStrategies } from '../backtest.js';
import { REGIME } from '../market/regime.js';
import { dailyReview, newsMonitor } from '../ai/advisor.js';
import { analyzeSymbolStats } from '../market/analyze.js';
import { getClock } from '../market/clock.js';
import { pnlWindows } from '../market/pnl.js';
import { backtestQuickbot, walkForwardQuickbot, seedQuickbots, quickbotLeaderboard, runLeaderboardPlay, SIGNAL_CATALOG, QUICK_DTES, DTE_BANDS, PARAM_META } from '../quickbot.js';
import { botPerformance } from '../perf.js';
import { portfolioRisk } from '../portfolio/risk.js';
import { kellySizing } from '../sizing/kelly.js';
import { tradeJournal, setJournalMeta } from '../journal.js';
import { getAlertRules, setAlertRules, runAlertEngine, alertKillSwitch, raiseAlert } from '../alerts.js';
import { promotionChecklist, promoteBot } from '../promotion.js';
import { ensureFleet, resetFleet, botCount } from '../fleet.js';
import { refreshNews } from '../market/news.js';
import { getBars } from '../brokers/index.js';
import { expirations as optExpirations, getChain, contractPrice } from '../brokers/options.js';
import { liveQuote, fundamentals, tickerOverview, livePrices } from '../market/ticker.js';
import { campaignView, seedCampaign, recordSnapshot, armCampaign, activateArmedIfFunded } from '../campaign.js';
import { tradeAnalysis, tuneBots } from '../analysis.js';
import { getFocus, setFocus, learnTicker, tickerBrain, FOCUS_TICKERS } from '../focus.js';
import { searchKnowledge } from '../knowledge.js';
import { knowledgeStats } from '../rag.js';
import { getFutures, leadingFuture } from '../market/futures.js';
import { runLearning, listRuns, listIdeas, learningStatus } from '../learning.js';

/** Attach each bot's EFFECTIVE risk (bot value, else the global trade default, with the
 *  source of every field) to a bot list. Additive — no existing field changes. */
async function withEffectiveRisk(rows: any[]): Promise<any[]> {
  const g = await getTradeDefaults();
  return rows.map((b) => ({ ...b, effective_risk: resolveRiskWith(b.risk, g) }));
}

/** Parse a positive-integer :id param, or null if invalid. */
function intId(req: any): number | null {
  const n = Number(req?.params?.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Validate a manual order/risk-check body. Returns an error string or null. */
function validateDraft(b: any): string | null {
  if (!b || typeof b !== 'object') return 'missing order body';
  if (!b.symbol || typeof b.symbol !== 'string' || !/^[A-Za-z.\-]{1,12}$/.test(b.symbol)) return 'invalid symbol';
  if (b.side !== 'buy' && b.side !== 'sell') return "side must be 'buy' or 'sell'";
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) return 'qty must be a positive number';
  if (b.order_type && !['market', 'limit', 'stop', 'stop_limit'].includes(b.order_type)) return 'invalid order_type';
  if (b.asset_class && !['equity', 'etf', 'option'].includes(String(b.asset_class).toLowerCase())) return 'invalid asset_class';
  if (String(b.asset_class).toLowerCase() === 'option' && b.option_type && !['call', 'put'].includes(b.option_type)) return 'invalid option_type';
  return null;
}

export async function registerRoutes(app: FastifyInstance) {
  // Sanitized global error handler — proper status + clean message (no stack leak).
  app.setErrorHandler((err: any, _req, reply) => {
    const code = err?.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(code).send({ error: err?.message || 'internal error' });
  });

  // ── Health & status ───────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    const env = await getTradingEnv();
    const live = isLiveEnv(env);
    const db = await ping();
    const watch = {
      available: false,
      observeOnly: true,
      running: false,
      lastCycle: null as string | null,
      lastError: null as string | null,
      note: 'Muse watcher is optional. If this API is down, treat watch as unknown — never green.',
    };
    return {
      ok: db,
      db,
      ai: aiReady(),
      aiLabel: aiLabel(),
      aiShort: aiShort(),
      rh: { status: rh.status, tools: rh.listToolsCached().length, authUrl: rh.authUrl },
      mode: await getGlobalMode(),
      killSwitch: await getKillSwitch(),
      env,
      live,
      paper: !live,
      listen: `127.0.0.1:${config.server.port}`,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      broker: await brokerStatus(),
      model: aiShort(),
      watch,
    };
  });

  // Which model answers which task, and what the last liveness probe saw.
  app.get('/api/ai/models', async () => {
    if (!probedOnce()) await probeProviders();
    const tasks: Record<string, { provider: string; model: string; live: boolean | null }[]> = {};
    for (const t of TASKS) tasks[t] = resolveChain(t);
    return { tasks, providers: providerStatus() };
  });

  // ── Trading environment (paper ↔ live) ───────────────────────────────────
  app.get('/api/env', async () => ({
    env: await getTradingEnv(),
    envs: TRADING_ENVS,
    live: isLiveEnv(await getTradingEnv()),
    broker: await brokerStatus(),
  }));
  app.post('/api/env', async (req, reply) => {
    const env = (req.body as any)?.env as TradingEnv;
    const confirm = (req.body as any)?.confirm === true;
    if (!TRADING_ENVS.includes(env)) return reply.code(400).send({ error: 'invalid env' });
    // Switching to a LIVE (real-money) environment requires explicit confirmation.
    if (isLiveEnv(env) && !confirm) {
      return reply.code(409).send({ error: 'confirmation_required', env, message: 'Switching to a REAL-MONEY environment requires confirm:true' });
    }
    // Leaving an env with OPEN monitors pauses those stops (the monitor loop only
    // evaluates the active env) — say so loudly instead of silently. (2026-08-24 audit)
    const prevEnv = await getTradingEnv();
    let warning: string | null = null;
    if (prevEnv !== env) {
      const [om] = await q<{ n: number }>(
        "SELECT COUNT(*) n FROM position_monitors WHERE status='open' AND (env=:e OR (env IS NULL AND :e='alpaca_paper'))", { e: prevEnv },
      );
      if (Number(om?.n)) {
        warning = `${om!.n} open position monitor(s) on ${prevEnv} will NOT be evaluated while on ${env} — those stops are paused until you switch back`;
        await raiseAlert({ level: 'critical', source: 'system', title: `Stops paused on ${prevEnv}`, body: warning });
      }
    }
    await setTradingEnv(env);
    await audit('env.change', `trading env → ${env}${isLiveEnv(env) ? ' (LIVE/REAL MONEY)' : ' (paper)'}`);
    // A newly connected account starts with its OWN fleet: fresh bots, all disabled, no
    // inherited picks/graduations/tuning. Orders, monitors, journal and P/L were already
    // env-scoped, so this account's history starts empty too. Catalog defaults only —
    // seeding must not run backtests (minutes) or need an open market at switch time.
    let fleet: any = null;
    if ((await botCount(env)) === 0) {
      fleet = await ensureFleet(env).catch((e: any) => ({ error: e?.message || String(e) })); // same lock + retry path as the worker net
      if (fleet && !fleet.error) await audit('bots.fleet_seeded', `seeded a fresh bot fleet for ${env} (${fleet.bots} bots, all disabled)`, fleet);
    }
    // Pull the new environment's portfolio immediately so the UI swaps without
    // waiting for the next worker sync tick (best-effort — won't block the switch).
    const synced = await syncAll().catch(() => null);
    return { env, live: isLiveEnv(env), synced, warning, fleet };
  });

  app.get('/api/rh/status', async () => ({
    status: rh.status,
    lastError: rh.lastError,
    authUrl: rh.authUrl,
    tools: rh.listToolsCached(),
  }));
  app.post('/api/rh/connect', async () => ({ status: await rh.connect() }));
  app.post('/api/rh/auth/start', async () => rh.beginAuth());
  app.post('/api/rh/sync', async () => syncAll());

  // ── Account / positions / orders ──────────────────────────────────────────
  // All scoped to the ACTIVE trading environment so switching paper ↔ live
  // swaps the entire portfolio view (e.g. your unfunded Robinhood account → $0).
  app.get('/api/account', async () => {
    const env = await getTradingEnv();
    return (await q('SELECT * FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1', { env }))[0] ?? null;
  });
  app.get('/api/positions', async () => {
    const env = await getTradingEnv();
    const rows = await q<any>('SELECT * FROM positions WHERE env=:env ORDER BY market_value DESC', { env });
    // Overlay LIVE prices (cached ~5s) so current price / value / P&L update every
    // poll, not just on the 30s broker sync. Equity/ETF only (clean price source).
    const equity = rows.filter((r) => (r.asset_class || 'equity') !== 'option' && Number(r.qty));
    const prices = await livePrices(equity.map((r) => r.symbol)).catch(() => ({} as Record<string, number | null>));
    for (const r of rows) {
      const last = prices[String(r.symbol).toUpperCase()];
      if (last != null && (r.asset_class || 'equity') !== 'option' && Number(r.qty)) {
        r.last_price = last;
        r.market_value = Math.round(last * Number(r.qty) * 100) / 100;
        if (r.avg_cost != null) r.unrealized_pl = Math.round((last - Number(r.avg_cost)) * Number(r.qty) * 100) / 100;
        r.live = true;
      }
    }
    return rows;
  });
  // Batch live quotes for a set of symbols — used by the UI for live ticking.
  app.get('/api/quotes', async (req) => {
    const syms = String((req.query as any)?.symbols || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    return { prices: await livePrices(syms), ts: Date.now() };
  });
  app.get('/api/orders', async (req) => {
    const env = await getTradingEnv();
    const lim = Math.min(Math.max(1, Number((req.query as any)?.limit) || 100), 500); // clamp ≥1 (negative LIMIT crashes MySQL)
    return q('SELECT * FROM orders WHERE env=:env ORDER BY created_at DESC LIMIT :lim', { env, lim });
  });
  // Signals are per-bot explainability, so they follow the bot's account (rows with no
  // bot_id are manual/AI evaluations and stay visible).
  app.get('/api/signals', async () => q(
    `SELECT s.* FROM signals s LEFT JOIN bots b ON b.id=s.bot_id
      WHERE s.bot_id IS NULL OR b.env=:env ORDER BY s.created_at DESC LIMIT 100`,
    { env: await getTradingEnv() },
  ));

  // ── Market clock ──────────────────────────────────────────────────────────
  app.get('/api/clock', async () => getClock());

  // ── Windowed account P/L (day/week/month/90d/YTD) from real broker equity history ──
  app.get('/api/pnl', async () => pnlWindows());

  // ── Options chain explorer (real Alpaca data) ─────────────────────────────
  app.get('/api/options/expirations/:symbol', async (req) =>
    ({ symbol: String((req.params as any).symbol).toUpperCase(), expirations: await optExpirations(String((req.params as any).symbol).toUpperCase()) }),
  );
  app.get('/api/options/chain/:symbol', async (req) => {
    const symbol = String((req.params as any).symbol).toUpperCase();
    const exps = await optExpirations(symbol);
    if (!exps.length) return { symbol, expirations: [], expiration: null, calls: [], puts: [], spot: null };
    let exp = String((req.query as any)?.expiration || '');
    if (!exps.includes(exp)) exp = exps[0];
    const closes = await getBars(symbol, '1Day', 3).catch(() => [] as number[]);
    const spot = closes.length ? closes[closes.length - 1] : null;
    const { calls, puts } = await getChain(symbol, exp);
    // feed is Alpaca's 'indicative' (derived) feed, not OPRA NBBO — surfaced so the UI can say so.
    return { symbol, expirations: exps.slice(0, 16), expiration: exp, spot, calls, puts, feed: 'indicative' };
  });
  app.get('/api/options/price', async (req) => ({ price: await contractPrice(String((req.query as any)?.symbol || '')) }));

  // ── Live quote / fundamentals / ticker hub (all available RH + Alpaca data) ─
  app.get('/api/quote/:symbol', async (req) => liveQuote(String((req.params as any).symbol)));
  app.get('/api/fundamentals/:symbol', async (req) => (await fundamentals(String((req.params as any).symbol))) ?? { error: 'unavailable (connect Robinhood)' });
  app.get('/api/ticker/:symbol', async (req) => tickerOverview(String((req.params as any).symbol)));

  // ── Growth campaign ($1k → $100k) ─────────────────────────────────────────
  app.get('/api/campaign', async () => (await campaignView()) ?? { active: false });
  app.post('/api/campaign/seed', async (req) => {
    const b = (req.body as any) || {};
    const today = new Date().toISOString().slice(0, 10);
    return seedCampaign({ start: b.start, target: b.target, days: b.days, today });
  });
  app.post('/api/campaign/snapshot', async (req) => {
    const b = (req.body as any) || {};
    return (await recordSnapshot({ deposits: b.deposits, note: b.note })) ?? { error: 'no active campaign' };
  });
  // RE-ARM: archive the current run and stage a fresh campaign that starts automatically
  // when the Robinhood account is funded (start equity = the actual deposit).
  app.post('/api/campaign/rearm', async (req) => {
    const b = (req.body as any) || {};
    return armCampaign({ target: Number(b.target) > 0 ? Number(b.target) : undefined, days: Number(b.days) > 0 ? Number(b.days) : undefined });
  });
  app.post('/api/campaign/check-funding', async () => (await activateArmedIfFunded()) ?? { started: false, note: 'no armed campaign or account not funded yet' });

  // ── Trade forensics: per-trade P/L%, peak/giveback, per-bot rollup + suggestions ─────
  app.get('/api/trades/analysis', async (req) => {
    const days = Math.min(90, Math.max(1, Number((req.query as any)?.days) || 7));
    return tradeAnalysis({ days });
  });
  // History-driven tuning of each bot's stop/trail (dry-run unless {apply:true}).
  app.post('/api/bots/tune', async (req) => {
    const b = (req.body as any) || {};
    return tuneBots({ days: Number(b.days) > 0 ? Number(b.days) : undefined, apply: b.apply === true });
  });

  // ── Strategy scan: rank all bots over the window, badge 10x–100x + regime fit ─
  app.post('/api/backtest/scan', async (req) => {
    const days = Math.min(Math.max(30, Number((req.body as any)?.days) || 182), 365);
    return scanStrategies({ days });
  });
  app.get('/api/regime', async () => REGIME);

  // ── Alerts (Groq→Kimi news pipeline + daily review highlights) ─────────────
  app.get('/api/alerts', async (req) => {
    const lim = Math.min(Math.max(1, Number((req.query as any)?.limit) || 30), 100);
    return q('SELECT * FROM alerts ORDER BY created_at DESC LIMIT :lim', { lim });
  });
  app.post('/api/alerts/:id/seen', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const r = await exec('UPDATE alerts SET status=:s WHERE id=:id', { s: 'seen', id });
    if (!r.affectedRows) return reply.code(404).send({ error: 'alert not found' });
    return { ok: true };
  });
  app.post('/api/alerts/dismiss/:id', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const r = await exec('UPDATE alerts SET status=:s WHERE id=:id', { s: 'dismissed', id });
    if (!r.affectedRows) return reply.code(404).send({ error: 'alert not found' });
    return { ok: true };
  });
  // Manually trigger the AI loops (also run on timers in the worker).
  app.post('/api/advisor/review', async () => dailyReview(true));
  app.post('/api/advisor/news', async () => newsMonitor());

  // ── Operational alert rules + on-demand engine run (fills/exits/failed-exits/drawdown) ──
  app.get('/api/alerts/rules', async () => ({ rules: await getAlertRules() }));
  app.post('/api/alerts/rules', async (req) => ({ rules: await setAlertRules((req.body as any) || {}) }));
  app.post('/api/alerts/run', async () => runAlertEngine());

  // ── FOCUS MODE (concentrate the whole app on one ticker) ───────────────────
  app.get('/api/focus', async () => ({ ...(await getFocus()), tickers: FOCUS_TICKERS }));
  app.post('/api/focus', async (req) => {
    const b = (req.body as any) || {};
    return setFocus({ enabled: b.enabled, symbol: b.symbol });
  });
  app.get('/api/focus/brain/:symbol', async (req) => tickerBrain(String((req.params as any).symbol)));
  app.post('/api/focus/learn', async (req) => {
    const sym = String((req.body as any)?.symbol || (await getFocus()).symbol);
    return learnTicker(sym);
  });

  // ── Knowledge / RAG search (news + research + learnings + insights) ────────
  app.get('/api/knowledge/search', async (req) => {
    const Q = req.query as any;
    return { results: await searchKnowledge(String(Q?.q || ''), { symbol: Q?.symbol ? String(Q.symbol) : undefined, limit: Number(Q?.limit) || 20 }) };
  });
  // Corpus health: rows per account (NULL env = shared market knowledge) + embedding coverage.
  app.get('/api/knowledge/stats', async () => knowledgeStats());
  app.get('/api/news/search', async (req) => {
    const Q = req.query as any;
    const hits = await searchKnowledge(String(Q?.q || ''), { symbol: Q?.symbol ? String(Q.symbol) : undefined, limit: 30 });
    return { results: hits.filter((h) => h.source === 'news') };
  });

  // ── Futures (real, incl. overnight) — leading indicators for the ETFs ──────
  app.get('/api/futures', async () => getFutures());
  app.get('/api/futures/for/:symbol', async (req) => ({ future: await leadingFuture(String((req.params as any).symbol)) }));

  // ── Watchlist ─────────────────────────────────────────────────────────────
  app.get('/api/watchlist', async () => q('SELECT * FROM watchlist ORDER BY added_at ASC LIMIT 200'));
  app.post('/api/watchlist', async (req) => {
    const b = req.body as any;
    await exec('INSERT INTO watchlist (symbol, note) VALUES (:s,:n) ON DUPLICATE KEY UPDATE note=:n', {
      s: String(b.symbol).toUpperCase(), n: b.note ?? null,
    });
    return { ok: true };
  });
  app.delete('/api/watchlist/:symbol', async (req) => {
    await exec('DELETE FROM watchlist WHERE symbol=:s', { s: String((req.params as any).symbol).toUpperCase() });
    return { ok: true };
  });

  // ── 3-month market analysis (real Alpaca data) ────────────────────────────
  app.get('/api/market/analyze/:symbol', async (req) => {
    const days = Math.min(Math.max(1, Number((req.query as any)?.days) || 90), 250);
    const r = await analyzeSymbolStats(String((req.params as any).symbol).toUpperCase(), days);
    return r ?? { error: 'no data (Alpaca not configured?)' };
  });

  // ── Backtests ─────────────────────────────────────────────────────────────
  app.post('/api/bots/:id/backtest', async (req) => {
    const id = Number((req.params as any).id);
    const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id, env: await getTradingEnv() });
    if (!bot) return { error: 'not found' };
    const days = Math.min(Math.max(1, Number((req.query as any)?.days) || 90), 250);
    return backtestBot(bot, { days });
  });
  app.post('/api/backtest', async (req) => {
    const b = req.body as any;
    let rules = b.rules ?? {};
    let action = b.action ?? {};
    let asset_class = b.asset_class;
    // If a bot id is given, use its strategy (lets the UI backtest any saved bot).
    let risk: any = {};
    if (b.bot_id) {
      const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id: Number(b.bot_id), env: await getTradingEnv() });
      if (bot) {
        const J = (v: any, d: any) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
        rules = J(bot.rules, {}); action = J(bot.action, {}); asset_class = bot.asset_class; risk = J(bot.risk, {});
      }
    }
    return backtest(
      { symbol: String(b.symbol).toUpperCase(), rules, action, asset_class },
      {
        from: b.from || undefined, to: b.to || undefined, days: Math.min(Math.max(5, Number(b.days) || 90), 400),
        takeProfitPct: Number(risk.take_profit_pct) || undefined,
        stopLossPct: Number(risk.stop_loss_pct) || undefined,
        trailingStopPct: Number(risk.trailing_stop_pct) || undefined,
        realOptions: !!b.realOptions,
      },
    );
  });
  app.post('/api/backtest/all', async (req) => {
    const days = Math.min(Math.max(1, Number((req.query as any)?.days) || 90), 250);
    const bots = await q<any>('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env: await getTradingEnv() });
    const out: any[] = [];
    for (const bot of bots) {
      try { out.push(await backtestBot(bot, { days })); } catch (e: any) { out.push({ bot: bot.name, error: e?.message }); }
    }
    return out;
  });
  app.get('/api/backtests', async () => q('SELECT * FROM backtests ORDER BY created_at DESC LIMIT 60'));

  // ── Playbooks (research-backed strategy ideas) ────────────────────────────
  app.get('/api/playbooks', async () => q('SELECT * FROM playbooks ORDER BY created_at DESC LIMIT 200'));
  app.post('/api/playbooks', async (req) => {
    const b = req.body as any;
    const res = await exec(
      `INSERT INTO playbooks (symbol,title,category,side,option_type,horizon,target_multiple,thesis,setup,stats,risk,bot_id)
       VALUES (:symbol,:title,:category,:side,:ot,:horizon,:tm,:thesis,CAST(:setup AS JSON),CAST(:stats AS JSON),:risk,:bid)`,
      {
        symbol: b.symbol, title: b.title, category: b.category, side: b.side ?? 'buy',
        ot: b.option_type ?? null, horizon: b.horizon ?? 'swing', tm: b.target_multiple ?? null,
        thesis: b.thesis ?? '', setup: JSON.stringify(b.setup ?? {}), stats: JSON.stringify(b.stats ?? {}),
        risk: b.risk ?? '', bid: b.bot_id ?? null,
      },
    );
    return { id: res.insertId };
  });
  app.get('/api/risk/events', async () => q('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT 100'));

  // ── Live position monitors (trailing-stop / TP / SL enforcement) ──────────
  app.get('/api/monitors', async () => {
    const env = await getTradingEnv();
    return q("SELECT * FROM position_monitors WHERE env=:env OR (env IS NULL AND :env='alpaca_paper') ORDER BY status ASC, opened_at DESC LIMIT 100", { env });
  });
  app.post('/api/monitors/check', async () => (await import('../risk/monitor.js')).checkMonitors());
  app.get('/api/audit', async () => q('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 150'));

  // ── Modes & kill switch ───────────────────────────────────────────────────
  app.get('/api/mode', async () => ({ mode: await getGlobalMode(), modes: MODES, killSwitch: await getKillSwitch() }));
  app.post('/api/mode', async (req, reply) => {
    const mode = (req.body as any)?.mode as Mode;
    if (!MODES.includes(mode)) return reply.code(400).send({ error: 'invalid mode' });
    await setSetting('global_mode', mode);
    await audit('mode.change', `global mode → ${mode}`);
    return { mode };
  });
  app.post('/api/kill', async (req) => {
    const on = !!(req.body as any)?.on;
    await setSetting('kill_switch', on);
    await audit('kill_switch', on ? 'ENGAGED' : 'released');
    await alertKillSwitch(on).catch(() => {});
    return { killSwitch: on };
  });

  // ── Manual order + risk preview ───────────────────────────────────────────
  app.post('/api/risk/check', async (req, reply) => {
    const err = validateDraft(req.body as any);
    if (err) return reply.code(400).send({ error: err });
    return riskCheck((req.body as any) as OrderDraft);
  });
  app.post('/api/orders', async (req, reply) => {
    const err = validateDraft(req.body as any);
    if (err) return reply.code(400).send({ error: err });
    const draft = { ...(req.body as any), source: 'manual' } as OrderDraft;
    return executeDraft(draft);
  });

  // ── Adjustable risk limits (concentration, position cap, daily loss, orders/day) ─
  app.get('/api/risk/limits', async () => ({ limits: await getRiskLimits(), defaults: riskLimitDefaults() }));
  app.post('/api/risk/limits', async (req) => ({ limits: await setRiskLimits((req.body as any) || {}) }));
  // ── Trade defaults: money per trade + exits every bot inherits ──────────────
  // `trade_defaults` is what a bot uses for any field it does not set itself; `factory` is
  // the baseline derived from the .env position cap, for the per-field "reset" control.
  app.get('/api/trade-defaults', async () => ({ trade_defaults: await getTradeDefaults(), factory: await tradeDefaultsFactory() }));
  app.post('/api/trade-defaults', async (req) => ({ trade_defaults: await setTradeDefaults((req.body as any) || {}), factory: await tradeDefaultsFactory() }));

  // Global overnight/weekend hold policy (per-bot overrides live in each bot's risk config).
  app.get('/api/exit-policy', async () => ({ policy: await getExitPolicy() }));
  app.post('/api/exit-policy', async (req) => ({ policy: await setExitPolicy((req.body as any) || {}) }));

  // ── Approvals (cautious mode) ─────────────────────────────────────────────
  app.get('/api/approvals', async () =>
    q("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 200"),
  );
  app.post('/api/approvals/:id/approve', async (req) =>
    (await approveOrder(Number((req.params as any).id))) ?? { error: 'not found or not pending' },
  );
  app.post('/api/approvals/:id/reject', async (req) => {
    await rejectOrder(Number((req.params as any).id));
    return { ok: true };
  });

  // ── Strategy catalog & bots ───────────────────────────────────────────────
  app.get('/api/strategies', async () => STRATEGY_LIBRARY);
  app.post('/api/strategies/seed', async () => seedStrategies(await getTradingEnv()));

  // ── QuickBots (short-DTE calls & puts, DTE-scaled risk, empirically tuned) ──
  app.get('/api/quickbots', async () => {
    const rows = await q<any>("SELECT * FROM bots WHERE env=:env AND JSON_EXTRACT(action,'$._quickbot')=true ORDER BY id ASC", { env: await getTradingEnv() });
    return withEffectiveRisk(rows);
  });
  app.post('/api/quickbots/seed', async (req) => {
    const force = !!(req.body as any)?.force;
    return seedQuickbots(await getTradingEnv(), { force });
  });
  app.get('/api/quickbots/signals', async () => ({ signals: SIGNAL_CATALOG, dtes: QUICK_DTES, bands: DTE_BANDS, param_meta: PARAM_META }));
  // Per-bot LIVE performance attribution from real orders + monitors (realized + open P/L).
  app.get('/api/bots/performance', async () => botPerformance());

  // ── Portfolio-level risk: aggregate exposure, gross/net delta, concentration, correlation ──
  app.get('/api/portfolio/risk', async () => portfolioRisk());

  // ── Kelly / vol-target position sizing wired off REAL backtest expectancy ──────────────
  app.get('/api/sizing/kelly', async (req, reply) => {
    const Q = req.query as any;
    const symbol = String(Q?.symbol || '').toUpperCase();
    if (!symbol) return reply.code(400).send({ error: 'symbol required' });
    try {
      return await kellySizing({ symbol, key: Q?.key ? String(Q.key) : undefined, dte: Q?.dte ? Number(Q.dte) : undefined, equity: Q?.equity ? Number(Q.equity) : undefined });
    } catch (e: any) { return reply.code(400).send({ error: e?.message || String(e) }); }
  });

  // ── Walk-forward / out-of-sample overfit detector for a symbol's QuickBot grid ─────────
  app.get('/api/quickbots/walkforward', async (req, reply) => {
    const Q = req.query as any;
    const symbol = String(Q?.symbol || '').toUpperCase();
    if (!symbol) return reply.code(400).send({ error: 'symbol required' });
    const days = Math.min(730, Math.max(180, Number(Q?.days) || 365));
    const folds = Math.min(8, Math.max(3, Number(Q?.folds) || 5));
    try { return await walkForwardQuickbot(symbol, { days, folds }); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || String(e) }); }
  });

  // ── Trade journal (real round-trips from closed monitors) + tags/notes/review ──────────
  app.get('/api/journal', async (req) => {
    const Q = req.query as any;
    return tradeJournal(undefined, {
      status: ['open', 'closed', 'all'].includes(String(Q?.status)) ? Q.status : 'closed',
      bot_id: Q?.bot_id ? Number(Q.bot_id) : undefined, tag: Q?.tag ? String(Q.tag) : undefined,
      limit: Q?.limit ? Number(Q.limit) : undefined,
    });
  });
  app.post('/api/journal/:id/meta', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const b = (req.body as any) || {};
    try { return await setJournalMeta(id, { tags: Array.isArray(b.tags) ? b.tags : undefined, note: typeof b.note === 'string' ? b.note : undefined, reviewed: typeof b.reviewed === 'boolean' ? b.reviewed : undefined }); }
    catch (e: any) { return reply.code(404).send({ error: e?.message || String(e) }); }
  });

  // ── Paper → live promotion: graduation checklist + promote (drops bot to Cautious) ─────
  app.get('/api/bots/:id/promotion', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    try { return await promotionChecklist(id); }
    catch (e: any) { return reply.code(404).send({ error: e?.message || String(e) }); }
  });
  app.post('/api/bots/:id/promote', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    try { return await promoteBot(id, { force: !!(req.body as any)?.force }); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || String(e) }); }
  });
  // Universe-wide backtest leaderboard ("which symbol × strategy × DTE would have paid"). Cached ~10min.
  app.get('/api/quickbots/leaderboard', async (req) => {
    const days = Math.min(730, Math.max(120, Number((req.query as any)?.days) || 365));
    return quickbotLeaderboard(days);
  });
  // One-click: run a backtested leaderboard play live (adds it to the managed Picks bot, enabled).
  app.post('/api/quickbots/run-play', async (req, reply) => {
    const b = (req.body as any) || {};
    try { return await runLeaderboardPlay(await getTradingEnv(), { symbol: b.symbol, key: b.key, dte: Number(b.dte), mode: b.mode, robust: b.robust, backtest: b.backtest }); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || String(e) }); }
  });
  // Read-only diagnostic: prove a QuickBot's option resolves to a REAL tradable contract on
  // BOTH brokers (Alpaca chain + Robinhood's own chain). Places nothing.
  app.get('/api/quickbots/resolve-check', async (req) => {
    const sym = String((req.query as any)?.symbol || 'QQQ').toUpperCase();
    const type = ((req.query as any)?.type === 'put' ? 'put' : 'call') as 'call' | 'put';
    const dte = Math.max(1, Number((req.query as any)?.dte) || 7);
    const { resolveContract, resolveContractRH } = await import('../brokers/options.js');
    const { dteToExpiration } = await import('../market/expirations.js');
    const exp = dteToExpiration(dte);
    const [alp, rhc] = await Promise.all([
      resolveContract(sym, type, 'atm', exp).catch((e) => ({ error: String(e?.message || e) })),
      resolveContractRH(sym, type, 'atm', exp).catch((e) => ({ error: String(e?.message || e) })),
    ]);
    const rhTradable = !!(rhc as any)?.instrumentId; // a real RH instrument id ⇒ tradable on Robinhood
    return { symbol: sym, type, dte, target_expiration: exp, rh_connected: rh.isConnected(), rh_tradable: rhTradable, alpaca: alp, robinhood: rhc };
  });
  app.get('/api/quickbot/:id/backtest', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id, env: await getTradingEnv() });
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    const action = typeof bot.action === 'string' ? JSON.parse(bot.action) : bot.action;
    const symbols: string[] = typeof bot.symbols === 'string' ? JSON.parse(bot.symbols) : bot.symbols;
    const days = Math.min(730, Math.max(90, Number((req.query as any)?.days) || 365));
    // Backtest the requested symbol (default: the bot's research symbol or first symbol).
    const sym = String((req.query as any)?.symbol || action?._research || symbols[0]).toUpperCase();
    const bt = await backtestQuickbot(sym, { days });
    return { bot: bot.name, symbols, ...bt };
  });

  // Bots belong to the ACTIVE account. Switching accounts swaps the whole fleet;
  // another account's bots are never listed, evaluated, edited or deleted from here.
  app.get('/api/bots', async () => withEffectiveRisk(await q('SELECT * FROM bots WHERE env=:env ORDER BY id ASC', { env: await getTradingEnv() })));

  // Delete this account's bots and seed a fresh fleet (all disabled). Bots only: orders,
  // position monitors, the journal and the audit log are the record of what really
  // happened and are never touched.
  app.post('/api/bots/reset-fleet', async (req, reply) => {
    const b = (req.body as any) || {};
    const env = (b.env ?? (await getTradingEnv())) as TradingEnv;
    if (!TRADING_ENVS.includes(env)) return reply.code(400).send({ error: 'invalid env' });
    if (b.confirm !== true) return reply.code(409).send({ error: 'confirmation_required', env, message: 'Resetting a fleet deletes every bot for that account. Send confirm:true.' });
    const res = await resetFleet(env, { forceOrphan: b.force_orphan === true });
    if (res?.refused) return reply.code(409).send({ error: 'refused', env, ...res });
    return res;
  });
  app.post('/api/bots', async (req, reply) => {
    const b = req.body as any;
    if (!b?.name || typeof b.name !== 'string') return reply.code(400).send({ error: 'bot name required' });
    const symbols = Array.isArray(b.symbols) ? b.symbols.map((s: any) => String(s).toUpperCase()) : [];
    const ac = ['equity', 'etf', 'option'].includes(String(b.asset_class).toLowerCase()) ? String(b.asset_class).toLowerCase() : 'equity';
    const mode = MODES.includes(b.mode) ? b.mode : 'observe';
    const res = await exec(
      `INSERT INTO bots (name, env, enabled, symbols, asset_class, rules, ai_gate, action, risk, mode)
       VALUES (:name,:env,:enabled,CAST(:symbols AS JSON),:ac,CAST(:rules AS JSON),CAST(:ai AS JSON),CAST(:action AS JSON),CAST(:risk AS JSON),:mode)`,
      {
        name: String(b.name).slice(0, 120),
        env: await getTradingEnv(),   // a new bot always belongs to the account you are on
        enabled: b.enabled ? 1 : 0,
        symbols: JSON.stringify(symbols),
        ac,
        rules: JSON.stringify(b.rules ?? {}),
        ai: JSON.stringify(b.ai_gate ?? { enabled: false }),
        action: JSON.stringify(b.action ?? { side: 'buy', qty: 1, order_type: 'market' }),
        risk: JSON.stringify(b.risk ?? {}),
        mode,
      },
    );
    return { id: res.insertId };
  });
  app.put('/api/bots/:id', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const b = req.body as any;
    const r = await exec(
      `UPDATE bots SET name=:name, enabled=:enabled, symbols=CAST(:symbols AS JSON), asset_class=:ac,
        rules=CAST(:rules AS JSON), ai_gate=CAST(:ai AS JSON), action=CAST(:action AS JSON),
        risk=CAST(:risk AS JSON), mode=:mode WHERE id=:id AND env=:env`,
      {
        id,
        env: await getTradingEnv(),
        name: b.name,
        enabled: b.enabled ? 1 : 0,
        symbols: JSON.stringify(b.symbols ?? []),
        ac: b.asset_class ?? 'equity',
        rules: JSON.stringify(b.rules ?? {}),
        ai: JSON.stringify(b.ai_gate ?? { enabled: false }),
        action: JSON.stringify(b.action ?? {}),
        risk: JSON.stringify(b.risk ?? {}),
        mode: b.mode ?? 'observe',
      },
    );
    if (!r.affectedRows) return reply.code(404).send({ error: 'bot not found' });
    return { ok: true };
  });
  // Merge a PARTIAL risk override into a bot (sizing + exits only). Sending null for a
  // field clears it, so the bot falls back to the global trade defaults. Deliberately a
  // whitelist: the engine's own caps (override/max_position_usd/concentration/daily-loss/
  // orders-per-day) are NOT settable here, so this route can never loosen the risk gate.
  app.put('/api/bots/:id/risk', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const env = await getTradingEnv();
    const [bot] = await q<any>('SELECT id, risk FROM bots WHERE id=:id AND env=:env', { id, env });
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    const body = (req.body as any) || {};
    const unknown = Object.keys(body).filter((k) => !(RISK_FIELDS as readonly string[]).includes(k));
    if (unknown.length) return reply.code(400).send({ error: `unsupported field(s): ${unknown.join(', ')}` });
    const cur = (typeof bot.risk === 'string' ? JSON.parse(bot.risk || '{}') : bot.risk) || {};
    const next: any = { ...cur };
    for (const k of RISK_FIELDS as readonly RiskField[]) {
      if (!(k in body)) continue;
      const raw = body[k];
      if (raw == null || raw === '') { delete next[k]; continue; }   // cleared -> inherit the global
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: `${k} must be a number >= 0` });
      // take_profit 0 is a REAL value ("no cap, ride the trail"); a 0 stop/trail or a 0
      // dollar amount means nothing, so it clears the override instead.
      if (k === 'take_profit_pct') next[k] = n <= 0 ? 0 : Math.min(500, Math.max(1, n));
      else if (n <= 0) delete next[k];
      else if (k.endsWith('_pct')) next[k] = Math.min(95, Math.max(1, n));
      else next[k] = Math.min(1_000_000_000, Math.max(25, n));       // money fields
    }
    // Keep the money fields ordered within the bot's own overrides.
    if (Number(next.min_usd) > 0 && Number(next.amount_usd) > 0 && next.min_usd > next.amount_usd) next.min_usd = next.amount_usd;
    if (Number(next.max_usd) > 0 && Number(next.amount_usd) > 0 && next.max_usd < next.amount_usd) next.max_usd = next.amount_usd;
    await exec('UPDATE bots SET risk=CAST(:r AS JSON) WHERE id=:id AND env=:env', { r: JSON.stringify(next), id, env });
    await audit('bot.risk.set', `risk overrides updated for bot #${id}`, { id, env, risk: next });
    return { ok: true, risk: next, effective_risk: await resolveBotRisk(next) };
  });
  app.delete('/api/bots/:id', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const r = await exec('DELETE FROM bots WHERE id=:id AND env=:env', { id, env: await getTradingEnv() });
    if (!r.affectedRows) return reply.code(404).send({ error: 'bot not found' });
    return { ok: true };
  });
  // Idempotent enable/disable: sets an EXPLICIT target state. Preferred over /toggle —
  // immune to double-clicks and stale reads (a blind flip could silently turn a bot
  // back off if clicked twice during network latency).
  app.post('/api/bots/:id/enable', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const want = (req.body as any)?.enabled ? 1 : 0;
    const env = await getTradingEnv();
    const r = await exec('UPDATE bots SET enabled=:want WHERE id=:id AND env=:env', { want, id, env });
    if (!r.affectedRows) return reply.code(404).send({ error: 'bot not found' });
    return (await q('SELECT id, enabled FROM bots WHERE id=:id AND env=:env', { id, env }))[0];
  });
  app.post('/api/bots/:id/toggle', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const env = await getTradingEnv();
    const r = await exec('UPDATE bots SET enabled = 1 - enabled WHERE id=:id AND env=:env', { id, env });
    if (!r.affectedRows) return reply.code(404).send({ error: 'bot not found' });
    return (await q('SELECT id, enabled FROM bots WHERE id=:id AND env=:env', { id, env }))[0];
  });
  app.post('/api/bots/:id/mode', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const mode = (req.body as any)?.mode as Mode;
    if (!MODES.includes(mode)) return reply.code(400).send({ error: 'invalid mode' });
    const r = await exec('UPDATE bots SET mode=:m WHERE id=:id AND env=:env', { m: mode, id, env: await getTradingEnv() });
    if (!r.affectedRows) return reply.code(404).send({ error: 'bot not found' });
    return { ok: true, mode };
  });
  app.post('/api/bots/:id/evaluate', async (req, reply) => {
    const id = intId(req); if (id == null) return reply.code(400).send({ error: 'invalid id' });
    const [bot] = await q<any>('SELECT * FROM bots WHERE id=:id AND env=:env', { id, env: await getTradingEnv() });
    if (!bot) return reply.code(404).send({ error: 'not found' });
    return evaluateBot(bot);
  });
  app.post('/api/bots/evaluate-all', async () => evaluateAllEnabledBots());

  // ── Research / news ───────────────────────────────────────────────────────
  app.post('/api/research/:symbol', async (req) =>
    analyzeSymbol(String((req.params as any).symbol).toUpperCase(), (req.body as any)?.context),
  );
  app.get('/api/research', async (req) => {
    const s = (req.query as any)?.symbol;
    return s
      ? q('SELECT * FROM research_analyses WHERE symbol=:s ORDER BY created_at DESC LIMIT 20', { s: String(s).toUpperCase() })
      : q('SELECT * FROM research_analyses ORDER BY created_at DESC LIMIT 50');
  });
  app.get('/api/news', async (req) => {
    const s = (req.query as any)?.symbol;
    return s
      ? q('SELECT * FROM news WHERE symbol=:s ORDER BY published_at DESC LIMIT 60', { s: String(s).toUpperCase() })
      : q('SELECT * FROM news ORDER BY published_at DESC LIMIT 60');
  });
  app.post('/api/news/refresh', async (req) => {
    const s = (req.body as any)?.symbols as string[] | undefined;
    return refreshNews(s);
  });

  // ── Research desk (my own findings) + earnings ────────────────────────────
  app.get('/api/research-notes', async (req) => {
    const s = (req.query as any)?.symbol;
    return s
      ? q('SELECT * FROM research_notes WHERE symbol=:s ORDER BY updated_at DESC LIMIT 200', { s: String(s).toUpperCase() })
      : q('SELECT * FROM research_notes ORDER BY updated_at DESC LIMIT 200');
  });
  app.get('/api/earnings', async (req) => {
    const s = (req.query as any)?.symbol;
    return s
      ? q('SELECT * FROM earnings WHERE symbol=:s ORDER BY report_date ASC LIMIT 200', { s: String(s).toUpperCase() })
      : q('SELECT * FROM earnings ORDER BY report_date ASC LIMIT 200');
  });
  app.get('/api/earnings-docs', async (req) => {
    const s = (req.query as any)?.symbol;
    return s
      ? q("SELECT * FROM earnings_docs WHERE symbol=:s ORDER BY analyzed DESC, doc_type LIMIT 200", { s: String(s).toUpperCase() })
      : q('SELECT * FROM earnings_docs ORDER BY symbol, analyzed DESC LIMIT 200');
  });

  // ── Learning iterator (daily/weekly): review → ideas → backtest → DISABLED bots ─────
  // Nothing here can enable a bot, raise a mode or place an order. A kept idea becomes a
  // bot with enabled=0 and mode 'cautious'; a human promotes it or it stays inert.
  app.post('/api/learning/run', async (req, reply) => {
    const b = (req.body as any) || {};
    const env = (b.env ?? (await getTradingEnv())) as TradingEnv;
    if (!TRADING_ENVS.includes(env)) return reply.code(400).send({ error: 'invalid env' });
    const kind = b.kind === 'weekly' ? 'weekly' : 'daily';
    try { return await runLearning(env, { kind, dryRun: b.dry_run === true, force: b.force === true }); }
    catch (e: any) { return reply.code(400).send({ error: e?.message || String(e) }); }
  });
  app.get('/api/learning/runs', async (req) => {
    const Q = req.query as any;
    const env = (TRADING_ENVS.includes(Q?.env) ? Q.env : await getTradingEnv()) as TradingEnv;
    return { env, runs: await listRuns(env, Number(Q?.limit) || 30) };
  });
  app.get('/api/learning/ideas', async (req) => {
    const Q = req.query as any;
    const env = (TRADING_ENVS.includes(Q?.env) ? Q.env : await getTradingEnv()) as TradingEnv;
    return { env, ideas: await listIdeas(env, { status: Q?.status ? String(Q.status) : undefined, limit: Number(Q?.limit) || 100 }) };
  });
  app.get('/api/learning/status', async (req) => {
    const Q = req.query as any;
    const env = (TRADING_ENVS.includes(Q?.env) ? Q.env : await getTradingEnv()) as TradingEnv;
    return learningStatus(env);
  });

  // ── Chat / agent ──────────────────────────────────────────────────────────
  app.get('/api/chat', async () => q('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 50'));
  app.post('/api/chat', async (req) => assistantChat(String((req.body as any)?.message ?? '')));
  app.post('/api/agent', async (req) =>
    agentTradeTurn(String((req.body as any)?.prompt ?? ''), { allowOpenNew: !!(req.body as any)?.allowOpenNew }),
  );
}
