import { useState } from 'react';
import { SetBotRisk } from '../api/client';
import { Info } from './ui';

// Trade sizing + exits, in one place. The same six fields appear as the GLOBAL defaults
// (Settings) and as a per-bot override (Bots / QuickBots), so a value means the same thing
// everywhere: amount = target dollars per trade, min/max bracket it, tp/sl/trail are
// percentages of the entry price (option premium for contracts, share price for shares).

export type RiskField = 'amount_usd' | 'min_usd' | 'max_usd' | 'take_profit_pct' | 'stop_loss_pct' | 'trailing_stop_pct';

export const RISK_FIELDS: { key: RiskField; label: string; money?: boolean; suffix: string; help: string; placeholder?: string }[] = [
  { key: 'amount_usd', label: 'Amount per trade', money: true, suffix: '$', help: 'Target dollars committed to one trade. Shares: amount ÷ price. Options: amount ÷ (premium × 100), so it always buys whole contracts. Rounded DOWN to whole units, then held inside the min/max below. Leave blank to opt out: bots keep their own lot sizes.', placeholder: 'Not set: bots keep their own lot sizes' },
  { key: 'min_usd', label: 'Minimum', money: true, suffix: '$', help: 'Smallest trade worth placing. If the sized order comes out under this, the trade is skipped with a reason instead of buying a token position.' },
  { key: 'max_usd', label: 'Maximum', money: true, suffix: '$', help: 'Largest a single trade may be. The risk engine\'s own position cap still applies on top, whichever is tighter, and one unit costing more than this skips the trade.' },
  { key: 'take_profit_pct', label: 'Take profit', suffix: '%', help: '0 means no cap: the winner keeps running and exits on the trailing stop. Any other value closes the trade at that gain and caps your upside.' },
  { key: 'stop_loss_pct', label: 'Stop loss', suffix: '%', help: 'Fixed loss that closes the trade. Small and firm is the point: the system trades for small losses and big wins.' },
  { key: 'trailing_stop_pct', label: 'Trailing stop', suffix: '%', help: 'Give-back from the best price reached. This is what lets a winner run and still bank most of the move.' },
];

export const usd = (n: any) => (n != null && Number.isFinite(Number(n)) ? `$${Math.round(Number(n)).toLocaleString('en-US')}` : '—');
export const fmtField = (k: RiskField, v: any) =>
  k === 'take_profit_pct' && Number(v) <= 0 ? 'none' : k.endsWith('_pct') ? `${Number(v)}%` : usd(v);

/** One-line plain summary of a resolved risk set: "$1,000 per trade, tp none / sl 35% / trail 40%".
 *  amount_usd is opt-in — no bot or global amount means sizing is skipped entirely. */
export function sizingLine(eff: any): string {
  if (!eff) return '';
  const amount = eff.amount_usd == null ? 'not set (bots use their own lot sizes)' : `${usd(eff.amount_usd)} per trade`;
  return `${amount}, take profit ${fmtField('take_profit_pct', eff.take_profit_pct)} / stop ${eff.stop_loss_pct}% / trail ${eff.trailing_stop_pct}%`;
}

/** Compact, tappable risk cell: effective amount + exits, with a tag on inherited fields. */
export function RiskCell({ bot, reload, compact }: { bot: any; reload: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const eff = bot?.effective_risk;
  if (!eff) return <span className="muted">—</span>;
  const chip = (k: RiskField, text: string) => (
    <span key={k} className="risk-chip-item">
      {text}
      {eff.source?.[k] === 'global' && <span className="risk-tag">global</span>}
    </span>
  );
  return (
    <div className="risk-cell">
      <button type="button" className="risk-chip" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Set the amount per trade and the exits for this bot">
        {chip('amount_usd', usd(eff.amount_usd))}
        {chip('take_profit_pct', `tp ${fmtField('take_profit_pct', eff.take_profit_pct)}`)}
        {chip('stop_loss_pct', `sl ${eff.stop_loss_pct}%`)}
        {!compact && chip('trailing_stop_pct', `trail ${eff.trailing_stop_pct}%`)}
        <span className="risk-chip-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <BotRiskEditor bot={bot} onDone={() => { setOpen(false); reload(); }} onCancel={() => setOpen(false)} />}
    </div>
  );
}

/** Inline editor for one bot's six risk fields. Each field is either the bot's own number
 *  or "Use global", which clears the override so the bot follows Settings. */
export function BotRiskEditor({ bot, onDone, onCancel }: { bot: any; onDone: () => void; onCancel: () => void }) {
  const eff = bot.effective_risk || {};
  const [form, setForm] = useState<Record<string, { global: boolean; value: string }>>(() =>
    Object.fromEntries(RISK_FIELDS.map((f) => [f.key, { global: eff.source?.[f.key] !== 'bot', value: String(eff[f.key] ?? '') }])),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    const body: any = {};
    for (const f of RISK_FIELDS) body[f.key] = form[f.key].global ? null : Number(form[f.key].value);
    try { await SetBotRisk(bot.id, body); onDone(); }
    catch (e: any) { setErr('Save failed: ' + String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="risk-editor" onClick={(e) => e.stopPropagation()}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Sizing and exits for <b>{bot.name}</b>. Leave a field on <b>Use global</b> to follow the Settings default, or switch it to this bot’s own number.
      </div>
      <div className="risk-grid">
        {RISK_FIELDS.map((f) => {
          const st = form[f.key];
          return (
            <div key={f.key} className="risk-field">
              <label className="muted" htmlFor={`r${bot.id}-${f.key}`}>{f.label}<Info text={f.help} /></label>
              <div className="risk-input-row">
                <span className="risk-prefix">{f.money ? '$' : ''}</span>
                <input id={`r${bot.id}-${f.key}`} type="number" inputMode="decimal" min={0} step={f.money ? 50 : 1}
                  placeholder={f.placeholder} disabled={st.global} value={st.global ? String(eff[f.key] ?? '') : st.value}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: { ...s[f.key], value: e.target.value } }))} />
                {!f.money && <span className="muted" style={{ fontSize: 12 }}>%</span>}
              </div>
              <label className="risk-toggle">
                <input type="checkbox" checked={st.global}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: { global: e.target.checked, value: s[f.key].value || String(eff[f.key] ?? '') } }))} />
                Use global
              </label>
            </div>
          );
        })}
      </div>
      {RISK_FIELDS.some((f) => !form[f.key].global && f.key === 'take_profit_pct' && Number(form[f.key].value) > 0) && (
        <div className="amber" style={{ fontSize: 12, marginTop: 8 }}>A take profit above 0 caps this bot’s upside. 0 lets winners ride the trailing stop.</div>
      )}
      {err && <div className="red" style={{ fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save risk'}</button>
        <button disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
