import { useState, useEffect } from 'react';
import { SetBotMode, SetBotEnabled } from '../api/client';
import { Info } from './ui';

// Bot mode definitions + plain-English explanations, reused everywhere (dashboard, bots
// page, quickbots). Each mode escalates autonomy: Observe → Cautious → Auto → Full-Auto.
export const MODE_INFO: Record<string, { label: string; short: string; tip: string; cls: string }> = {
  observe: { label: 'Observe', short: 'obs', cls: 'blue', tip: 'WATCH ONLY — logs every signal but places NO orders. Use it to watch how a bot behaves before trusting it with money.' },
  cautious: { label: 'Cautious', short: 'caut', cls: 'amber', tip: 'STAGE FOR APPROVAL — when the bot fires, the order waits for your one-click approve/reject on the Orders page. Nothing trades without you. Best default for a new strategy.' },
  auto: { label: 'Auto', short: 'auto', cls: 'green', tip: 'AUTO-TRADE — executes automatically when the rules + risk engine pass, no approval needed. The TP/SL/trailing-stop monitor enforces exits. Real money if your environment is Live.' },
  full_auto: { label: 'Full-Auto', short: 'full', cls: 'red', tip: 'FULL AUTONOMY — auto-executes its rules with the SOFT sizing caps OFF: position-size, concentration, and orders/day limits no longer veto (still computed + shown for reference). Only the kill switch and the daily-loss circuit breaker (plus no-crypto / long-only) can still stop a buy. The most hands-off mode. Real money if Live — use once you trust the bot.' },
};
export const MODES = ['observe', 'cautious', 'auto', 'full_auto'] as const;

/** The full "what do the modes mean" explainer (for an Info tooltip / legend). */
export const MODE_LEGEND =
  'Bot modes (increasing autonomy): Observe = watch only, no orders. Cautious = every order is staged for your one-click approval. Auto = trades automatically when rules + risk pass (exits auto-enforced). Full-Auto = trades automatically with the soft sizing caps OFF (position/concentration/orders-per-day no longer veto) — only the kill switch + daily-loss breaker + no-crypto/long-only still apply. Enable the bot (ON), then pick a mode — you can change either from any tab.';

/** Reusable enable toggle + mode segmented control with per-mode tooltips. Works on ANY
 *  tab — calls the API and the parent's reload; optimistic so it feels instant. */
export function BotModeControl({ bot, reload, showEnable = true, showLegend = false, size = 'sm' }: {
  bot: any; reload: () => void; showEnable?: boolean; showLegend?: boolean; size?: 'sm' | 'md';
}) {
  const [pendEnabled, setPendEnabled] = useState<boolean | null>(null);
  const [pendMode, setPendMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = pendEnabled ?? !!bot.enabled;
  const mode = pendMode ?? bot.mode;
  useEffect(() => { if (pendEnabled != null && !!bot.enabled === pendEnabled) setPendEnabled(null); }, [bot.enabled, pendEnabled]);
  useEffect(() => { if (pendMode != null && bot.mode === pendMode) setPendMode(null); }, [bot.mode, pendMode]);

  const toggle = async () => {
    if (busy) return;
    // Enabling a bot that's already in a real-trading mode arms autonomous orders — confirm.
    if (!enabled && (mode === 'auto' || mode === 'full_auto')) {
      if (!confirm(`Enable "${bot.name}" — it's in ${MODE_INFO[mode].label} mode and will trade AUTOMATICALLY when its rules fire (real money if your environment is Live). Continue?`)) return;
    }
    setBusy(true); setPendEnabled(!enabled);
    try { await SetBotEnabled(bot.id, !enabled); reload(); } catch { setPendEnabled(null); } finally { setBusy(false); }
  };
  const setMode = async (m: string) => {
    if (m === mode || busy) return;
    // Escalating to a real-trading mode is a meaningful step — confirm the jump to auto/full.
    if ((m === 'auto' || m === 'full_auto') && mode !== 'auto' && mode !== 'full_auto') {
      if (!confirm(`Switch "${bot.name}" to ${MODE_INFO[m].label}?\n\n${MODE_INFO[m].tip}`)) return;
    }
    setBusy(true); setPendMode(m);
    try { await SetBotMode(bot.id, m); reload(); } catch { setPendMode(null); } finally { setBusy(false); }
  };

  return (
    <span className="row" style={{ gap: 6, alignItems: 'center', fontSize: size === 'sm' ? 11 : 13 }} onClick={(e) => e.stopPropagation()}>
      <span className="mode-seg" title="Bot mode — hover each for what it does">
        {MODES.map((m) => (
          <button key={m} className={mode === m ? `on ${m}` : ''} title={MODE_INFO[m].tip} onClick={() => setMode(m)}>{MODE_INFO[m].short}</button>
        ))}
      </span>
      {showLegend && <Info text={MODE_LEGEND} />}
      {showEnable && (
        <button className={enabled ? 'primary' : ''} disabled={busy} onClick={toggle} title={enabled ? 'Bot is ON — click to disable' : 'Bot is OFF — click to enable (then pick a mode)'}>
          {busy ? '…' : enabled ? 'ON' : 'off'}
        </button>
      )}
    </span>
  );
}
