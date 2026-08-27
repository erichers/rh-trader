// Resolve the app's mount path so API calls work whether served from
// http://localhost:5173/ (dev), /rh.tradingbot/ (MAMP), or the Tauri app.
const APP_BASE = (() => {
  let p = window.location.pathname.replace(/index\.html$/, '').replace(/\/$/, '');
  return p;
})();

export const API = `${APP_BASE}/api`;

async function req<T = any>(path: string, opts?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body — otherwise
  // Fastify rejects empty-body POSTs with FST_ERR_CTP_EMPTY_JSON_BODY (400).
  const hasBody = opts?.body != null;
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(opts?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : (r.text() as any);
}

export const api = {
  get: <T = any>(p: string) => req<T>(p),
  post: <T = any>(p: string, body?: any) =>
    req<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T = any>(p: string, body?: any) =>
    req<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T = any>(p: string) => req<T>(p, { method: 'DELETE' }),
};

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${APP_BASE}/ws`;
}

// Typed-ish endpoint helpers --------------------------------------------------
export const Health = () => api.get('/health');
export const RhStatus = () => api.get('/rh/status');
export const RhConnect = () => api.post('/rh/connect');
export const RhAuthStart = () => api.post('/rh/auth/start');
export const RhSync = () => api.post('/rh/sync');
export const Account = () => api.get('/account');
export const Positions = () => api.get('/positions');
export const Orders = (limit = 100) => api.get(`/orders?limit=${limit}`);
export const Signals = () => api.get('/signals');
export const RiskEvents = () => api.get('/risk/events');
export const Audit = () => api.get('/audit');
export const GetMode = () => api.get('/mode');
export const SetMode = (mode: string) => api.post('/mode', { mode });
export const GetEnv = () => api.get('/env');
export const SetEnv = (env: string, confirm = false) => api.post('/env', { env, confirm });
export const SetKill = (on: boolean) => api.post('/kill', { on });
export const Bots = () => api.get('/bots');
export const Strategies = () => api.get('/strategies');
export const SeedStrategies = () => api.post('/strategies/seed');
export const ToggleBot = (id: number) => api.post(`/bots/${id}/toggle`);
export const SetBotEnabled = (id: number, enabled: boolean) => api.post(`/bots/${id}/enable`, { enabled });
export const Quickbots = () => api.get('/quickbots');
export const SeedQuickbots = (force = false) => api.post('/quickbots/seed', { force });
export const QuickbotBacktest = (id: number, days = 365, symbol?: string) => api.get(`/quickbot/${id}/backtest?days=${days}${symbol ? `&symbol=${symbol}` : ''}`);
export const QuickbotSignals = () => api.get('/quickbots/signals');
export const QuickbotResolveCheck = (symbol: string, type: string, dte: number) => api.get(`/quickbots/resolve-check?symbol=${symbol}&type=${type}&dte=${dte}`);
export const Leaderboard = (days = 365) => api.get(`/quickbots/leaderboard?days=${days}`);
export const BotPerformance = () => api.get('/bots/performance');
export const RunPlay = (body: { symbol: string; key: string; dte: number; mode: string; robust?: boolean; backtest?: any }) => api.post('/quickbots/run-play', body);
export const ExitPolicy = () => api.get('/exit-policy');
export const SetExitPolicy = (p: any) => api.post('/exit-policy', p);
export const SetBotMode = (id: number, mode: string) => api.post(`/bots/${id}/mode`, { mode });
export const EvalBot = (id: number) => api.post(`/bots/${id}/evaluate`);
export const Approvals = () => api.get('/approvals');
export const ApproveOrder = (id: number) => api.post(`/approvals/${id}/approve`);
export const RejectOrder = (id: number) => api.post(`/approvals/${id}/reject`);
export const PlaceOrder = (draft: any) => api.post('/orders', draft);
export const RiskCheck = (draft: any) => api.post('/risk/check', draft);
export const Research = (symbol?: string) =>
  api.get(`/research${symbol ? `?symbol=${symbol}` : ''}`);
export const RunResearch = (symbol: string, context?: string) =>
  api.post(`/research/${symbol}`, { context });
export const News = (symbol?: string) => api.get(`/news${symbol ? `?symbol=${symbol}` : ''}`);
export const NewsRefresh = (symbols?: string[]) => api.post('/news/refresh', symbols ? { symbols } : {});
export const Chat = (message: string) => api.post('/chat', { message });
export const Agent = (prompt: string, allowOpenNew = false) =>
  api.post('/agent', { prompt, allowOpenNew });
export const Clock = () => api.get('/clock');
export const Pnl = () => api.get('/pnl');
export const Watchlist = () => api.get('/watchlist');
export const AddWatch = (symbol: string, note?: string) => api.post('/watchlist', { symbol, note });
export const DelWatch = (symbol: string) => api.del(`/watchlist/${symbol}`);
export const AnalyzeSymbol = (symbol: string, days = 90) => api.get(`/market/analyze/${symbol}?days=${days}`);
export const BacktestBot = (id: number, days = 90) => api.post(`/bots/${id}/backtest?days=${days}`);
export const BacktestAll = (days = 90) => api.post(`/backtest/all?days=${days}`);
export const Backtests = () => api.get('/backtests');
export const RunBacktest = (body: any) => api.post('/backtest', body);
export const Monitors = () => api.get('/monitors');
export const Playbooks = () => api.get('/playbooks');
export const ResearchNotes = (symbol?: string) => api.get(`/research-notes${symbol ? `?symbol=${symbol}` : ''}`);
export const Earnings = (symbol?: string) => api.get(`/earnings${symbol ? `?symbol=${symbol}` : ''}`);
export const EarningsDocs = (symbol?: string) => api.get(`/earnings-docs${symbol ? `?symbol=${symbol}` : ''}`);
export const CreateBot = (bot: any) => api.post('/bots', bot);
export const OptChain = (symbol: string, expiration?: string) => api.get(`/options/chain/${symbol}${expiration ? `?expiration=${expiration}` : ''}`);
export const Quote = (symbol: string) => api.get(`/quote/${symbol}`);
export const Fundamentals = (symbol: string) => api.get(`/fundamentals/${symbol}`);
export const Ticker = (symbol: string) => api.get(`/ticker/${symbol}`);
export const Campaign = () => api.get('/campaign');
export const SeedCampaign = (body?: any) => api.post('/campaign/seed', body || {});
export const CampaignSnapshot = (body?: any) => api.post('/campaign/snapshot', body || {});
export const ScanStrategies = (days = 182) => api.post('/backtest/scan', { days });
export const Regime = () => api.get('/regime');
export const Alerts = (limit = 30) => api.get(`/alerts?limit=${limit}`);
export const AlertSeen = (id: number) => api.post(`/alerts/${id}/seen`);
export const AlertDismiss = (id: number) => api.post(`/alerts/dismiss/${id}`);
export const RunReview = () => api.post('/advisor/review');
export const RunNewsScan = () => api.post('/advisor/news');
export const Focus = () => api.get('/focus');
export const SetFocus = (enabled: boolean, symbol?: string) => api.post('/focus', { enabled, symbol });
export const FocusBrain = (symbol: string) => api.get(`/focus/brain/${symbol}`);
export const LearnTicker = (symbol?: string) => api.post('/focus/learn', symbol ? { symbol } : {});
export const KnowledgeSearch = (q: string, symbol?: string) => api.get(`/knowledge/search?q=${encodeURIComponent(q)}${symbol ? `&symbol=${symbol}` : ''}`);
export const NewsSearch = (q: string, symbol?: string) => api.get(`/news/search?q=${encodeURIComponent(q)}${symbol ? `&symbol=${symbol}` : ''}`);
export const Futures = () => api.get('/futures');
export const FutureFor = (symbol: string) => api.get(`/futures/for/${symbol}`);
export const RiskLimits = () => api.get('/risk/limits');
export const TradeDefaults = () => api.get('/trade-defaults');
export const SetTradeDefaults = (body: any) => api.post('/trade-defaults', body);
// Partial per-bot risk override; null on a field clears it (bot follows the global default).
export const SetBotRisk = (id: number, body: any) => api.put(`/bots/${id}/risk`, body);
export const SetRiskLimits = (body: any) => api.post('/risk/limits', body);

// ── Next-tier quant surfaces ────────────────────────────────────────────────
export const PortfolioRisk = () => api.get('/portfolio/risk');
export const KellySizing = (symbol: string, opts: { key?: string; dte?: number; equity?: number } = {}) => {
  const qs = new URLSearchParams({ symbol, ...(opts.key ? { key: opts.key } : {}), ...(opts.dte ? { dte: String(opts.dte) } : {}), ...(opts.equity ? { equity: String(opts.equity) } : {}) });
  return api.get(`/sizing/kelly?${qs.toString()}`);
};
export const WalkForward = (symbol: string, days = 365, folds = 5) => api.get(`/quickbots/walkforward?symbol=${symbol}&days=${days}&folds=${folds}`);
export const Journal = (opts: { status?: string; bot_id?: number; tag?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.bot_id) qs.set('bot_id', String(opts.bot_id));
  if (opts.tag) qs.set('tag', opts.tag);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const s = qs.toString();
  return api.get(`/journal${s ? `?${s}` : ''}`);
};
export const SetJournalMeta = (id: number, patch: { tags?: string[]; note?: string; reviewed?: boolean }) => api.post(`/journal/${id}/meta`, patch);

// Learning iterator (daily/weekly): runs, generated ideas, and a manual (dry) run.
export const LearningStatus = () => api.get('/learning/status');
export const LearningRuns = (limit = 30) => api.get(`/learning/runs?limit=${limit}`);
export const LearningIdeas = (status?: string) => api.get(`/learning/ideas${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const RunLearning = (body: { kind?: string; dry_run?: boolean; force?: boolean } = {}) => api.post('/learning/run', body);
export const AlertRules = () => api.get('/alerts/rules');
export const SetAlertRules = (body: any) => api.post('/alerts/rules', body);
export const RunAlertEngine = () => api.post('/alerts/run');
export const BotPromotion = (id: number) => api.get(`/bots/${id}/promotion`);
export const PromoteBot = (id: number, force = false) => api.post(`/bots/${id}/promote`, { force });
export const TradeAnalysis = (days = 7) => api.get(`/trades/analysis?days=${days}`);
export const TuneBots = (days = 14, apply = false) => api.post('/bots/tune', { days, apply });
export const RearmCampaign = (target = 100000) => api.post('/campaign/rearm', { target });
