// Clean, consistent line-icon set (Feather-style): single stroke, currentColor, no fill.
// Used in the sidebar nav and wherever we previously leaned on emoji. 24×24 viewBox,
// 1.75 stroke, round caps/joins — renders crisp at 16–20px.

export type IconName =
  | 'dashboard' | 'focus' | 'growth' | 'positions' | 'shield' | 'orders' | 'journal'
  | 'chart' | 'options' | 'bolt' | 'beaker' | 'bot' | 'library' | 'playbook' | 'backtest'
  | 'watchlist' | 'research' | 'news' | 'bell' | 'chat' | 'activity' | 'settings'
  | 'check' | 'x' | 'warning' | 'trophy' | 'gauge' | 'learn';

const P: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
  focus: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  growth: <><path d="M3 17l6-6 4 4 7-7" /><path d="M17 8h4v4" /></>,
  positions: <><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4" /><path d="M3 17l9 4 9-4" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  orders: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  journal: <><path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2V4z" /><path d="M5 4a2 2 0 0 0 2 2h9" /><path d="M9 12h6" /></>,
  chart: <><path d="M4 4v16h16" /><path d="M7 14l3-4 3 3 4-6" /></>,
  options: <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="18" r="2" /></>,
  bolt: <><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></>,
  beaker: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M7.5 15h9" /></>,
  bot: <><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M12 8V4M9 4h6" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /></>,
  library: <><path d="M4 5v15M9 5v15" /><rect x="3" y="4" width="7" height="16" rx="1" /><path d="M13 6l5 1-2 14-5-1z" /></>,
  playbook: <><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-3-7 3V5a1 1 0 0 1 1-1z" /></>,
  backtest: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>,
  watchlist: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="2.5" /></>,
  research: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  news: <><path d="M4 5h13v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5z" /><path d="M17 8h3v10a2 2 0 0 1-2 2" /><path d="M7 9h7M7 13h7M7 17h4" /></>,
  bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.3L3 21l1.2-3.6A8.4 8.4 0 1 1 21 11.5z" /></>,
  activity: <><path d="M3 12h4l3 8 4-16 3 8h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.2A1.6 1.6 0 0 0 7 19.3a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.2A1.6 1.6 0 0 0 2.7 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 2.7h.1A1.6 1.6 0 0 0 10 1.2V1a2 2 0 0 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 0 1 0 4h-.2a1.6 1.6 0 0 0-1.1 1z" /></>,
  check: <><path d="M5 12l5 5L20 7" /></>,
  x: <><path d="M6 6l12 12M18 6L6 18" /></>,
  warning: <><path d="M12 3l9 16H3l9-16z" /><path d="M12 10v4M12 17h.01" /></>,
  trophy: <><path d="M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M9 16h6M8 20h8M12 13v3" /></>,
  gauge: <><path d="M12 13l4-4" /><path d="M3 18a9 9 0 1 1 18 0" /><circle cx="12" cy="13" r="1.5" /></>,
  learn: <><path d="M3 8l9-4 9 4-9 4-9-4z" /><path d="M7 10.5V15c0 1.7 2.2 3 5 3s5-1.3 5-3v-4.5" /><path d="M21 8v6" /></>,
};

export function Icon({ name, size = 18, className, strokeWidth = 1.75 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" style={{ flex: '0 0 auto' }}>
      {P[name]}
    </svg>
  );
}
