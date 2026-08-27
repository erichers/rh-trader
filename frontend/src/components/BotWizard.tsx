import { useState } from 'react';
import { CreateBot, RunBacktest } from '../api/client';

// Reusable educational Add-Bot wizard. Launch from anywhere with an optional
// preset (ticker, strategy, option config). Walks through strategy → contract →
// money/risk constraints → mode, then creates the bot (enabled or watch).

export type BotPreset = {
  name?: string; symbols?: string[]; asset_class?: 'equity' | 'etf' | 'option';
  rules?: any; action?: any; mode?: string;
};

const STRATEGIES: { key: string; label: string; rules: any; explain: string; side?: string }[] = [
  { key: 'rsi-dip', label: 'RSI dip (buy oversold in uptrend)', rules: { rsi_below: 32, price_above_sma20: true, min_matches: 1 }, explain: 'Buys when RSI(14) drops below 32 while price holds above its 20-day average — a dip in an uptrend.' },
  { key: 'ema-cross', label: 'EMA 9/21 crossover (momentum up)', rules: { ema_cross: true }, explain: 'Enters when the fast EMA crosses above the slow EMA — momentum turning up.' },
  { key: 'breakout', label: 'Breakout (20-day high)', rules: { breakout_high: true }, explain: 'Buys new 20-day highs — rides momentum breakouts.' },
  { key: 'macd', label: 'MACD momentum + trend', rules: { macd_positive: true, price_above_sma20: true, require_all: true }, explain: 'Long while MACD histogram is positive and price is above its 20-day average.' },
  { key: 'breakdown', label: 'Breakdown (bearish → puts)', rules: { breakdown_low: true, death_cross: true, min_matches: 1 }, explain: 'Bearish trigger (new 20-day low / death cross) — pair with a long put.' },
  { key: 'overbought', label: 'Overbought fade (bearish → puts)', rules: { rsi_above: 70, bollinger_upper: true, min_matches: 1 }, explain: 'Fades overbought stretches (RSI>70 / upper band) — pair with a long put.' },
];

function Field({ label, hint, children }: any) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12 }}>{label}</div>
      {hint && <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{hint}</div>}
      {children}
    </label>
  );
}

export default function BotWizard({ preset, onClose, onCreated }: { preset?: BotPreset; onClose: () => void; onCreated?: () => void }) {
  const [step, setStep] = useState(1);
  const [stratKey, setStratKey] = useState(preset?.rules ? 'preset' : 'rsi-dip');
  const presetStrat = STRATEGIES.find((s) => s.key === stratKey);
  const [name, setName] = useState(preset?.name || '');
  const [symbols, setSymbols] = useState((preset?.symbols || ['AAPL']).join(', '));
  const [assetClass, setAssetClass] = useState<'equity' | 'etf' | 'option'>(preset?.asset_class || 'equity');
  const [optionType, setOptionType] = useState(preset?.action?.option_type || 'call');
  const [strike, setStrike] = useState(preset?.action?.strike_target || 'atm');
  const [expiration, setExpiration] = useState(preset?.action?.expiration || 'weekly');
  const [qty, setQty] = useState(preset?.action?.qty || 1);
  const [maxUsd, setMaxUsd] = useState(500);
  const [takeProfit, setTakeProfit] = useState(50);
  const [stopLoss, setStopLoss] = useState(40);
  const [trailing, setTrailing] = useState(25);
  const [mode, setMode] = useState(preset?.mode || 'observe');
  const [enabled, setEnabled] = useState(false);
  const [bt, setBt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const rules = stratKey === 'preset' ? preset?.rules : presetStrat?.rules;
  const explain = stratKey === 'preset' ? 'Using the strategy you selected.' : presetStrat?.explain;
  const symbolList = symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const isOpt = assetClass === 'option';

  const buildBot = (en: boolean) => ({
    name: name || `${symbolList[0] || 'BOT'} ${presetStrat?.label || 'strategy'}`,
    enabled: en ? 1 : 0,
    symbols: symbolList,
    asset_class: assetClass,
    rules,
    ai_gate: { enabled: false },
    action: { side: optionType === 'put' ? 'buy' : 'buy', qty: Number(qty), order_type: 'market', ...(isOpt ? { option_type: optionType, strike_target: strike, expiration } : {}) },
    risk: { max_position_usd: Number(maxUsd), take_profit_pct: Number(takeProfit), stop_loss_pct: Number(stopLoss), trailing_stop_pct: Number(trailing) },
    mode,
  });

  const preview = async () => {
    setBusy(true);
    try {
      const r = await RunBacktest({ symbol: symbolList[0], rules, action: buildBot(false).action, asset_class: assetClass, days: 120 });
      setBt(r.metrics);
    } catch { setBt(null); } finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setMsg('');
    try { await CreateBot(buildBot(enabled)); setMsg('Bot created' + (enabled ? ' & enabled' : ' (watching)')); onCreated?.(); setTimeout(onClose, 800); }
    catch (e: any) { setMsg('Error: ' + String(e)); } finally { setBusy(false); }
  };

  const steps = ['Strategy', isOpt ? 'Contract' : null, 'Money & risk', 'Mode', 'Review'].filter(Boolean) as string[];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 560, borderColor: 'var(--accent)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Add a bot</h2>
          <span className="muted">{steps.map((s, i) => <span key={s} className={i + 1 === stepIndex(step, isOpt) ? 'green' : 'muted'} style={{ marginLeft: 6 }}>{i + 1}.{s}</span>)}</span>
        </div>

        {step === 1 && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>A <b>bot</b> watches a ticker and fires a trade when its rules are met. Everything still passes the risk engine and your chosen mode — so a bot can never bypass your guardrails.</p>
            <Field label="Name" hint="Anything memorable."><input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${symbolList[0] || 'AAPL'} ${presetStrat?.label || ''}`} style={{ width: '100%' }} /></Field>
            <Field label="Ticker(s)" hint="Comma-separated. No crypto (blocked by policy).">
              <input value={symbols} onChange={(e) => setSymbols(e.target.value.toUpperCase())} style={{ width: '100%' }} />
            </Field>
            <Field label="Trade type">
              <select value={assetClass} onChange={(e) => setAssetClass(e.target.value as any)} style={{ width: '100%' }}>
                <option value="equity">Equity (shares)</option>
                <option value="etf">ETF (shares)</option>
                <option value="option">Options (long call / put — defined risk)</option>
              </select>
            </Field>
            <Field label="Strategy / trigger" hint={explain}>
              <select value={stratKey} onChange={(e) => setStratKey(e.target.value)} style={{ width: '100%' }}>
                {preset?.rules && <option value="preset">Selected strategy (prefilled)</option>}
                {STRATEGIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
          </div>
        )}

        {step === 2 && isOpt && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>You buy <b>long options</b> only — a <b>call</b> profits if the stock rises, a <b>put</b> profits if it falls. Max loss is the premium you pay (defined risk). No shorting, no writing.</p>
            <Field label="Call or Put" hint="Call = bullish, Put = bearish.">
              <div className="mode-seg"><button className={optionType === 'call' ? 'on auto' : ''} onClick={() => setOptionType('call')}>Call (bullish)</button><button className={optionType === 'put' ? 'on full_auto' : ''} onClick={() => setOptionType('put')}>Put (bearish)</button></div>
            </Field>
            <Field label="Strike" hint="ATM = at the money (balanced). OTM = cheaper, more leverage, lower odds. ITM = pricier, more like stock.">
              <select value={strike} onChange={(e) => setStrike(e.target.value)} style={{ width: '100%' }}><option value="atm">ATM</option><option value="otm">OTM</option><option value="itm">ITM</option></select>
            </Field>
            <Field label="Expiration" hint="Weekly = fast, cheap, high theta decay. Monthly = more time, steadier.">
              <select value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ width: '100%' }}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
            </Field>
          </div>
        )}

        {step === stepFor('money', isOpt) && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>Set how much you risk and when to exit. These are <b>per-bot</b> and stack on top of your global limits — the tighter one always wins.</p>
            <Field label="Max $ per trade" hint="The most this bot can put into one position. The risk engine vetoes anything larger."><input type="number" value={maxUsd} onChange={(e) => setMaxUsd(+e.target.value)} style={{ width: 140 }} /></Field>
            <Field label="Quantity" hint={isOpt ? 'Contracts (×100 shares each).' : 'Shares.'}><input type="number" value={qty} onChange={(e) => setQty(+e.target.value)} style={{ width: 100 }} /></Field>
            <div className="row" style={{ gap: 16 }}>
              <Field label="Take profit %" hint="Exit when up this much."><input type="number" value={takeProfit} onChange={(e) => setTakeProfit(+e.target.value)} style={{ width: 90 }} /></Field>
              <Field label="Stop loss %" hint="Exit when down this much."><input type="number" value={stopLoss} onChange={(e) => setStopLoss(+e.target.value)} style={{ width: 90 }} /></Field>
              <Field label="Trailing stop %" hint="Lock gains: exit if it retraces this much from its best."><input type="number" value={trailing} onChange={(e) => setTrailing(+e.target.value)} style={{ width: 90 }} /></Field>
            </div>
            <button onClick={preview} disabled={busy}>{busy ? 'Testing…' : 'Backtest these settings (120d)'}</button>
            {bt && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{bt.num_trades} trades · {bt.win_rate}% win · total {bt.total_return_pct}% · best {bt.best_multiple}× · ≥2× {bt.trades_2x}</div>}
          </div>
        )}

        {step === stepFor('mode', isOpt) && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>How should this bot act when its rule fires?</p>
            {[['observe', 'Observe — log only, place no orders (safest; just learn)'], ['cautious', 'Cautious — stage every order for your one-click approval'], ['auto', 'Auto — place orders automatically within your guardrails'], ['full_auto', 'Full-Auto — auto + may open new positions on its own']].map(([m, label]) => (
              <label key={m} className="row" style={{ padding: '6px 0' }}><input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> <span>{label}</span></label>
            ))}
            <label className="row" style={{ marginTop: 8 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <b>Enable now</b> <span className="muted">(off = saved as “watching”, you enable later)</span></label>
          </div>
        )}

        {step === stepFor('review', isOpt) && (
          <div style={{ marginTop: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>Review:</p>
            <div className="card" style={{ background: 'var(--panel2)', fontSize: 13 }}>
              <div><b>{name || `${symbolList[0]} ${presetStrat?.label || ''}`}</b></div>
              <div className="muted">{symbolList.join(', ')} · {isOpt ? `long ${optionType} ${strike} ${expiration}` : assetClass} · qty {qty}</div>
              <div className="muted">Trigger: {explain}</div>
              <div className="muted">Max ${maxUsd}/trade · TP {takeProfit}% · SL {stopLoss}% · trail {trailing}%</div>
              <div className="muted">Mode: <b>{mode}</b> · {enabled ? 'ENABLED' : 'watching'}</div>
            </div>
            {msg && <div style={{ marginTop: 8 }} className={msg.startsWith('Error') ? 'red' : 'green'}>{msg}</div>}
          </div>
        )}

        <div className="actions">
          {step > 1 && <button onClick={() => setStep(prevStep(step, isOpt))}>Back</button>}
          {!isLast(step, isOpt) ? (
            <button className="primary" onClick={() => setStep(nextStep(step, isOpt))} disabled={step === 1 && symbolList.length === 0}>Next</button>
          ) : (
            <button className="primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : (enabled ? 'Create & enable' : 'Create (watch)')}</button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Step math: when not options, step 2 (Contract) is skipped.
function stepFor(which: 'money' | 'mode' | 'review', isOpt: boolean): number {
  const base = isOpt ? { money: 3, mode: 4, review: 5 } : { money: 2, mode: 3, review: 4 };
  return base[which];
}
function isLast(step: number, isOpt: boolean) { return step === stepFor('review', isOpt); }
function nextStep(step: number, isOpt: boolean) { if (!isOpt && step === 1) return 2; return step + 1; }
function prevStep(step: number, isOpt: boolean) { if (!isOpt && step === 2) return 1; return step - 1; }
function stepIndex(step: number, isOpt: boolean) { return isOpt ? step : (step >= 2 ? step : step); }
