import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './components/icons';
import { Health, SetMode, SetKill, RhConnect, RhSync, SetEnv, RhAuthStart, Focus as FocusApi, SetFocus, SetJev } from './api/client';
import { jevLastShort, jevLastText, museTuneText } from './modelCopy';
import { readSidebarCollapsed, writeSidebarCollapsed } from './sidebarPref';
import { showRobinhoodConnect } from './deskChrome';
import DeskHealthStrip from './components/DeskHealthStrip';
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
import ModelsView from './views/Models';

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
    { to: '/models', label: 'Models', icon: 'chat' },
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
  if (!w) return 'gray';
  if (w.lastError) return 'amber';
  if (w.mode === 'improve' && (w.ok || w.running || w.lastCycle)) return w.running ? 'green' : 'amber';
  if (!w.available) return 'gray';
  if (w.running) return 'green';
  return 'gray';
}

function museWatchLabel(apiDown: boolean, health: any): string {
  if (apiDown || health?._unreachable) return 'unknown (API down)';
  const w = health?.watch;
  if (!w) return 'unknown';
  const mode = w.mode === 'improve' ? 'improve' : 'observe';
  const via = w.via === 'local' ? 'local' : '';
  const tune = museTuneText(w.lastTune);
  if (!w.available && mode !== 'improve') return 'n/a · observe-only';
  if (w.lastError) return `${mode} · error`;
  const bits = [mode, via, w.running ? 'running' : (w.lastCycle ? 'idle' : 'waiting'), tune].filter(Boolean);
  return bits.join(' · ');
}

function jevDot(apiDown: boolean, health: any): string {
  if (apiDown || !health || health._unreachable) return 'gray';
  const j = health.jev;
  if (!j || !j.enabled || j.mode === 'off') return 'gray';
  if (j.degraded) return 'red';
  if (j.mode === 'active' && j.ok) return 'green';
  if (j.mode === 'shadow' || j.mode === 'active') return 'amber';
  return 'gray';
}

function jevLabel(apiDown: boolean, health: any): string {
  if (apiDown || health?._unreachable) return 'unknown';
  const j = health?.jev;
  if (!j || !j.enabled || j.mode === 'off') return 'off';
  const spent = Number(j.spentUsd) || 0;
  const budget = Number(j.budgetUsd) || 5;
  const last = j.last;
  const lastBit = jevLastShort(last);
  const money = `$${spent.toFixed(2)}/$${budget}`;
  if (j.degraded) return `${j.mode} · budget · ${money}`;
  return [j.mode, money, lastBit].filter(Boolean).join(' · ');
}

function jevTitle(health: any): string {
  const j = health?.jev;
  if (!j) return 'Jev post-signal panel. off = never call TypeSafe.';
  const last = j.last;
  const bits = [
    `mode=${j.mode}`,
    `spent=$${Number(j.spentUsd || 0).toFixed(4)} / $${j.budgetUsd ?? 5}`,
    j.degraded ? `degraded: ${j.reason || 'yes'}` : 'ok',
    last ? jevLastText(last) : '',
  ].filter(Boolean);
  return bits.join(' · ');
}

export default function App() {
  const [health, setHealth] = useState<any>(null);
  const [apiDown, setApiDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingEnv, setPendingEnv] = useState<string | null>(null); // live-switch confirmation
  const [focus, setFocusState] = useState<any>({ enabled: false, symbol: 'SPY', tickers: ['SPY', 'QQQ'] });
  const [navCollapsed, setNavCollapsed] = useState(() => readSidebarCollapsed(typeof localStorage === 'undefined' ? null : localStorage));
  const [phoneNav, setPhoneNav] = useState(false);
  const toggleNav = () => {
    setNavCollapsed((cur) => {
      const next = !cur;
      writeSidebarCollapsed(typeof localStorage === 'undefined' ? null : localStorage, next);
      return next;
    });
  };

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
    const paper = (health?.env || 'alpaca_paper') !== 'robinhood_live';
    const ok = window.confirm(paper
      ? 'Connect Robinhood? This starts live-account OAuth. The paper desk does not need it.'
      : 'Connect Robinhood and start OAuth for the live account?');
    if (!ok) return;
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
      <div className={`app${isLive ? ' live' : ''}${navCollapsed ? ' nav-collapsed' : ''}${phoneNav ? ' phone-nav' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-full">rh.tradingbot</span>
            <span className="brand-mark">rh</span>
            <button
              type="button"
              className="nav-collapse"
              aria-expanded={!navCollapsed}
              aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={toggleNav}
            >{navCollapsed ? '›' : '‹'}</button>
          </div>
          <nav className="nav" onClick={() => setPhoneNav(false)}>
            {NAV.map((group, gi) => (
              <div className="nav-group" key={gi}>
                {group.label && <div className="nav-group-label">{group.label}</div>}
                {group.items.map((it) => (
                  <NavLink key={it.to} to={it.to} end={it.end} title={it.label}>
                    <Icon name={it.icon} size={17} className="nav-icon" />
                    <span className="nav-label">{it.to === '/focus' && focus.enabled ? `Focus · ${focus.symbol}` : it.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ padding: '0 18px', fontSize: 11 }} className="muted side-status">
            <div className="row"><span className={`dot ${apiDown ? 'red' : 'green'}`} /> API: {apiDown ? 'down (:8011)' : (health?.listen || 'up')}</div>
            {showRobinhoodConnect(env, isLive) && (
              <div className="row" style={{ marginTop: 4 }}>
                <span className={`dot ${rhDot}`} /> Robinhood: {apiDown ? 'unknown' : rhStatus}
              </div>
            )}
            <NavLink to="/models/ai" className="status-link" title={health?.aiLabel || 'AI research + chat'}>
              <span className={`dot ${apiDown ? 'gray' : (health?.ai ? 'green' : 'gray')}`} />
              <span className="status-text">AI: {apiDown ? 'unknown' : (health?.ai ? (health?.aiShort || 'ready') : 'no key')}</span>
            </NavLink>
            <div className="row" style={{ marginTop: 4 }}>
              <span className={`dot ${apiDown ? 'red' : (health?.db ? 'green' : 'red')}`} /> DB: {apiDown ? 'unknown' : (health?.db ? 'up' : 'down')}
            </div>
            <NavLink to="/models/muse" className="status-link" title={health?.watch?.note || 'Muse never places orders.'}>
              <span className={`dot ${museWatchDot(apiDown, health)}`} />
              <span className="status-text">Muse: {museWatchLabel(apiDown, health)}</span>
            </NavLink>
            <div className="row status-link" style={{ marginTop: 4, gap: 6 }}>
              <NavLink to="/models/jev" className="status-link" style={{ marginTop: 0, flex: 1 }} title={jevTitle(health)}>
                <span className={`dot ${jevDot(apiDown, health)}`} />
                <span className="status-text">Jev: {jevLabel(apiDown, health)}</span>
              </NavLink>
              <button
                style={{ fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                disabled={apiDown}
                title={health?.jev?.enabled && health?.jev?.mode !== 'off' ? 'Turn Jev off (no TypeSafe calls)' : 'Enable Jev in shadow (log only, never blocks)'}
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const on = !!(health?.jev?.enabled && health?.jev?.mode !== 'off');
                  await SetJev(on ? { enabled: false, mode: 'off' } : { enabled: true, mode: 'shadow' });
                  refresh();
                }}
              >{health?.jev?.enabled && health?.jev?.mode !== 'off' ? 'on' : 'off'}</button>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button type="button" className="nav-burger" aria-expanded={phoneNav} aria-label={phoneNav ? 'Close menu' : 'Open menu'} onClick={() => setPhoneNav((v) => !v)}>
              {phoneNav ? 'Close' : 'Menu'}
            </button>
            <ModeSwitcher mode={health?.mode || 'observe'} onChange={changeMode} />
            <MarketClock />
            {showRobinhoodConnect(env, isLive) && rhStatus !== 'connected' && (
              <button onClick={connect} disabled={busy}>{busy ? 'Opening…' : 'Connect Robinhood'}</button>
            )}
            {showRobinhoodConnect(env, isLive) && rhStatus === 'connected' && <button onClick={() => RhSync().then(refresh)}>Sync</button>}
            <span className="focus-ctl" title="Focus mode — concentrate the whole app + bots on one ticker">
              <button className={`icon-btn ${focus.enabled ? 'primary' : ''}`} onClick={toggleFocus}><Icon name="focus" size={15} />{focus.enabled ? 'Focus ON' : 'Focus'}</button>
              <select aria-label="Focus ticker" value={focus.symbol} onChange={(e) => pickFocus(e.target.value)} title="Focus ticker">
                {(focus.tickers || ['SPY', 'QQQ']).map((t: string) => <option key={t} value={t}>{t}</option>)}
              </select>
            </span>
            <div className="spacer" />
            <div className="desk-lock">
              <span className={`env-badge ${isLive ? 'live' : 'paper'}`} title="Trading environment">
                <span className="dot" />{ENV_LABELS[env] || env}
              </span>
              <DeskHealthStrip health={health} apiDown={apiDown} />
              <div className="desk-lock-row">
                <select
                  aria-label="Trading environment"
                  value={env}
                  onChange={(e) => changeEnv(e.target.value, e.target.value !== 'alpaca_paper')}
                  title="Alpaca paper is the desk. Live still asks for confirmation here and on the server."
                >
                  <option value="alpaca_paper">Paper (Alpaca)</option>
                  <option value="robinhood_live">Live — Robinhood</option>
                </select>
                <NavLink to="/models/ai" className="pill" title={health?.aiLabel}>{health?.aiShort || 'AI'}</NavLink>
                <button className={`kill-lock ${health?.killSwitch ? 'primary' : 'danger'}`} onClick={toggleKill}>
                  {health?.killSwitch ? 'KILL ENGAGED. Release' : 'KILL SWITCH'}
                </button>
              </div>
            </div>
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
              <Route path="/models" element={<ModelsView health={health} onChange={refresh} />} />
              <Route path="/models/:which" element={<ModelsView health={health} onChange={refresh} />} />
              <Route path="/settings" element={<Settings health={health} onChange={refresh} />} />
            </Routes>
          </div>
          <nav className="phone-dock" aria-label="Desk shortcuts">
            <NavLink to="/positions" onClick={() => setPhoneNav(false)}>Positions</NavLink>
            <NavLink to="/bots" onClick={() => setPhoneNav(false)}>Bots</NavLink>
          </nav>
        </div>

        {phoneNav && <button type="button" className="phone-scrim" aria-label="Close menu" onClick={() => setPhoneNav(false)} />}

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
