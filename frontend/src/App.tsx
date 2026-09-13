import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './components/icons';
import { Health, SetMode, SetKill, RhConnect, RhSync, SetEnv, RhAuthStart, Focus as FocusApi, SetFocus } from './api/client';
import MarketClock from './components/MarketClock';
import AccountStrip from './components/AccountStrip';
import Dashboard from './views/Dashboard';
import Positions from './views/Positions';
import Orders from './views/Orders';
import BotsView from './views/Bots';
import QuickBotsView from './views/QuickBots';
import StrategiesView from './views/Strategies';
import ResearchView from './views/Research';
import NewsView from './views/News';
import ChatView from './views/Chat';
import Activity from './views/Activity';
import Settings from './views/Settings';
import WatchlistView from './views/Watchlist';
import BacktestView from './views/Backtest';
import PlaybooksView from './views/Playbooks';
import ChartsView from './views/Charts';
import OptionsView from './views/Options';
import CampaignView from './views/Campaign';
import TickerDetail from './views/TickerDetail';
import FocusView from './views/Focus';
import Portfolio from './views/Portfolio';
import JournalView from './views/Journal';
import AlertsView from './views/Alerts';
import QuantLab from './views/QuantLab';
import LearningView from './views/Learning';

type NavItem = { to: string; label: string; icon: IconName; end?: boolean };
const NAV: { label?: string; items: NavItem[] }[] = [
  { items: [
    { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
    { to: '/focus', label: 'Focus', icon: 'focus' },
    { to: '/campaign', label: 'Growth Plan', icon: 'growth' },
  ] },
  { label: 'Portfolio', items: [
    { to: '/positions', label: 'Positions', icon: 'positions' },
    { to: '/portfolio', label: 'Portfolio Risk', icon: 'shield' },
    { to: '/orders', label: 'Orders', icon: 'orders' },
    { to: '/journal', label: 'Trade Journal', icon: 'journal' },
  ] },
  { label: 'Markets', items: [
    { to: '/charts', label: 'Charts & Explore', icon: 'chart' },
    { to: '/options', label: 'Options Explorer', icon: 'options' },
  ] },
  { label: 'Strategy', items: [
    { to: '/quickbots', label: 'QuickBots', icon: 'bolt' },
    { to: '/quant', label: 'Quant Lab', icon: 'beaker' },
    { to: '/learning', label: 'Learning', icon: 'learn' },
    { to: '/bots', label: 'Bots', icon: 'bot' },
    { to: '/strategies', label: 'Strategy Library', icon: 'library' },
    { to: '/playbooks', label: 'Playbooks', icon: 'playbook' },
    { to: '/backtest', label: 'Backtest', icon: 'backtest' },
  ] },
  { label: 'Intel', items: [
    { to: '/watchlist', label: 'Watchlist', icon: 'watchlist' },
    { to: '/research', label: 'Research', icon: 'research' },
    { to: '/news', label: 'News', icon: 'news' },
    { to: '/alerts', label: 'Alerts', icon: 'bell' },
    { to: '/chat', label: 'Ask AI', icon: 'chat' },
  ] },
  { label: 'System', items: [
    { to: '/activity', label: 'Activity & Risk', icon: 'activity' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];

const MODE_LABELS: Record<string, string> = {
  observe: 'Observe',
  cautious: 'Cautious',
  auto: 'Auto',
  full_auto: 'Full-Auto',
};

function ModeSwitcher({ mode, onChange }: { mode: string; onChange: (m: string) => void }) {
  return (
    <div className="mode-seg" title="Global execution mode">
      {['observe', 'cautious', 'auto', 'full_auto'].map((m) => (
        <button key={m} className={mode === m ? `on ${m}` : ''} onClick={() => onChange(m)}>
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

const ENV_LABELS: Record<string, string> = {
  alpaca_paper: 'PAPER · Alpaca',
  robinhood_live: 'LIVE · Robinhood',
};

function museWatchDot(apiDown: boolean, health: any): string {
  if (apiDown || !health || health._unreachable) return 'gray';
  const w = health.watch;
  if (!w || !w.available) return 'gray';
  if (w.lastError) return 'amber';
  if (w.running) return 'green';
  return 'gray';
}

function museWatchLabel(apiDown: boolean, health: any): string {
  if (apiDown || health?._unreachable) return 'unknown (API down)';
  const w = health?.watch;
  if (!w) return 'unknown';
  if (!w.available) return 'n/a · observe-only';
  if (w.lastError) return 'error';
  if (w.running) return 'running · observe-only';
  return 'idle · observe-only';
}

export default function App() {
  const [health, setHealth] = useState<any>(null);
  const [apiDown, setApiDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingEnv, setPendingEnv] = useState<string | null>(null); // live-switch confirmation
  const [focus, setFocusState] = useState<any>({ enabled: false, symbol: 'SPY', tickers: ['SPY', 'QQQ'] });

  const refresh = () => Health().then((h) => { setHealth(h); setApiDown(false); }).catch(() => {
    setHealth({ ok: false, _unreachable: true });
    setApiDown(true);
  });
  const refreshFocus = () => FocusApi().then(setFocusState).catch(() => {});
  useEffect(() => {
    refresh(); refreshFocus();
    const iv = setInterval(() => { if (!document.hidden) { refresh(); refreshFocus(); } }, 6000);
    return () => clearInterval(iv);
  }, []);
  const toggleFocus = async () => { await SetFocus(!focus.enabled, focus.symbol); refreshFocus(); };
  const pickFocus = async (s: string) => { await SetFocus(focus.enabled, s); refreshFocus(); };

  const changeMode = async (m: string) => {
    await SetMode(m);
    refresh();
  };
  const toggleKill = async () => {
    await SetKill(!health?.killSwitch);
    refresh();
  };
  const connect = async () => {
    setBusy(true);
    try {
      const r: any = await RhAuthStart();
      if (r?.authUrl) {
        // Open Robinhood's authorization page; the backend catches the redirect
        // on :7321 and finishes the OAuth automatically.
        window.open(r.authUrl, '_blank');
      } else if (r?.alreadyConnected) {
        await RhSync().catch(() => {});
      }
    } catch {
      await RhConnect().catch(() => {});
    } finally {
      setBusy(false);
      setTimeout(refresh, 1500);
    }
  };

  const changeEnv = async (env: string, isLive: boolean) => {
    if (isLive) { setPendingEnv(env); return; } // require confirmation
    await SetEnv(env, false);
    refresh();
  };
  const confirmLive = async () => {
    if (!pendingEnv) return;
    await SetEnv(pendingEnv, true);
    setPendingEnv(null);
    refresh();
  };

  const rhStatus = health?.rh?.status || 'unknown';
  const rhDot = rhStatus === 'connected' ? 'green' : rhStatus === 'needs_auth' ? 'amber' : 'red';
  const env = health?.env || 'alpaca_paper';
  const isLive = !!health?.live;

  return (
    <HashRouter>
      <div className={`app${isLive ? ' live' : ''}`}>
        <aside className="sidebar">
          <div className="brand">rh.tradingbot</div>
          <nav className="nav">
            {NAV.map((group, gi) => (
              <div className="nav-group" key={gi}>
                {group.label && <div className="nav-group-label">{group.label}</div>}
                {group.items.map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.end}>
                    <Icon name={it.icon} size={17} className="nav-icon" />
                    <span>{it.to === '/focus' && focus.enabled ? `Focus · ${focus.symbol}` : it.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ padding: '0 18px', fontSize: 11 }} className="muted">
            <div className="row"><span className={`dot ${apiDown ? 'red' : 'green'}`} /> API: {apiDown ? 'down (:8011)' : (health?.listen || 'up')}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className={`dot ${rhDot}`} /> Robinhood: {apiDown ? 'unknown' : rhStatus}
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className={`dot ${apiDown ? 'gray' : (health?.ai ? 'green' : 'gray')}`} /> AI: {apiDown ? 'unknown' : (health?.ai ? (health?.aiShort || 'ready') : 'no key')}
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className={`dot ${apiDown ? 'red' : (health?.db ? 'green' : 'red')}`} /> DB: {apiDown ? 'unknown' : (health?.db ? 'up' : 'down')}
            </div>
            <div className="row" style={{ marginTop: 4 }} title={health?.watch?.note || 'Muse watch is observe-only. Never green when the API is down.'}>
              <span className={`dot ${museWatchDot(apiDown, health)}`} /> Muse watch: {museWatchLabel(apiDown, health)}
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <ModeSwitcher mode={health?.mode || 'observe'} onChange={changeMode} />
            <MarketClock />
            {rhStatus !== 'connected' && (
              <button onClick={connect} disabled={busy}>{busy ? 'Opening…' : 'Connect Robinhood'}</button>
            )}
            {rhStatus === 'connected' && <button onClick={() => RhSync().then(refresh)}>Sync</button>}
            <span className="focus-ctl" title="Focus mode — concentrate the whole app + bots on one ticker">
              <button className={`icon-btn ${focus.enabled ? 'primary' : ''}`} onClick={toggleFocus}><Icon name="focus" size={15} />{focus.enabled ? 'Focus ON' : 'Focus'}</button>
              <select aria-label="Focus ticker" value={focus.symbol} onChange={(e) => pickFocus(e.target.value)} title="Focus ticker">
                {(focus.tickers || ['SPY', 'QQQ']).map((t: string) => <option key={t} value={t}>{t}</option>)}
              </select>
            </span>
            <div className="spacer" />
            <span className={`env-badge ${isLive ? 'live' : 'paper'}`} title="Trading environment">
              <span className="dot" />{ENV_LABELS[env] || env}
            </span>
            <select
              aria-label="Trading environment"
              value={env}
              onChange={(e) => changeEnv(e.target.value, e.target.value !== 'alpaca_paper')}
              title="Switch environment"
            >
              <option value="alpaca_paper">Paper (Alpaca)</option>
              <option value="robinhood_live">Live — Robinhood</option>
            </select>
            <span className="pill" title={health?.aiLabel}>{health?.aiShort || 'AI'}</span>
            <button className={health?.killSwitch ? 'primary' : 'danger'} onClick={toggleKill}>
              {health?.killSwitch ? '● KILL ENGAGED — release' : 'KILL SWITCH'}
            </button>
          </header>
          {apiDown && (
            <div className="api-down-banner">
              API down — backend not reachable on 127.0.0.1:8011. The static shell (MAMP :8888) can still show this page. Muse watch is unknown, not live. Start with <code>./scripts/start.sh</code> then <code>./scripts/health.sh</code>.
            </div>
          )}
          {isLive && (
            <div className="live-banner">
              ● LIVE — REAL MONEY ({ENV_LABELS[env]}). Orders place against your real account. Kill switch + risk limits still apply.
            </div>
          )}
          {focus.enabled && (
            <div className="focus-banner">
              <Icon name="focus" size={14} /> FOCUS MODE — the entire app + every enabled bot is concentrated on <b>{focus.symbol}</b>. <a href="#/focus">open focus →</a>
            </div>
          )}
          {/* Balances + windowed P/L on every route. Sits under the top bar, below the
              LIVE / focus banners so the real-money warning stays against the header. */}
          <AccountStrip health={health} />
          <div className="content">
            <Routes>
              <Route path="/" element={<Dashboard health={health} />} />
              <Route path="/focus" element={<FocusView />} />
              <Route path="/campaign" element={<CampaignView />} />
              <Route path="/ticker/:symbol" element={<TickerDetail />} />
              <Route path="/positions" element={<Positions health={health} />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/journal" element={<JournalView />} />
              <Route path="/quant" element={<QuantLab />} />
              <Route path="/learning" element={<LearningView />} />
              <Route path="/alerts" element={<AlertsView />} />
              <Route path="/charts" element={<ChartsView />} />
              <Route path="/options" element={<OptionsView />} />
              <Route path="/bots" element={<BotsView />} />
              <Route path="/quickbots" element={<QuickBotsView />} />
              <Route path="/strategies" element={<StrategiesView />} />
              <Route path="/playbooks" element={<PlaybooksView />} />
              <Route path="/backtest" element={<BacktestView />} />
              <Route path="/watchlist" element={<WatchlistView />} />
              <Route path="/research" element={<ResearchView />} />
              <Route path="/news" element={<NewsView />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/settings" element={<Settings health={health} onChange={refresh} />} />
            </Routes>
          </div>
        </div>

        {pendingEnv && (
          <div className="modal-overlay" onClick={() => setPendingEnv(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2 className="red icon-btn"><Icon name="warning" size={20} /> Switch to REAL MONEY?</h2>
              <p>
                You're switching to <b>{ENV_LABELS[pendingEnv]}</b>. From now on, orders that pass the
                risk engine and execution mode will be placed against your <b>real account</b> — not paper.
              </p>
              <p className="muted">
                The kill switch, no-crypto, long-only, and size/concentration limits still apply.
                Consider setting mode to <b>cautious</b> first so you approve each order.
              </p>
              <div className="actions">
                <button onClick={() => setPendingEnv(null)}>Cancel — stay on paper</button>
                <button className="danger" onClick={confirmLive}>Yes, go LIVE</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </HashRouter>
  );
}
