import { useState } from 'react';
import { Info } from '../components/ui';
import { WalkForwardPanel, KellyPanel, QUANT_UNIVERSE } from '../components/quanttools';

// Quant Lab — robustness + sizing tools for any symbol. Walk-forward exposes overfit leaderboard
// plays; Kelly turns a real backtested edge into a position size. Both run live backtests.

export default function QuantLab() {
  const [symbol, setSymbol] = useState('NVDA');
  const [input, setInput] = useState('NVDA');
  const apply = () => { const s = input.trim().toUpperCase(); if (s) setSymbol(s); };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Quant Lab <Info text="Robustness + sizing for any ticker. Walk-forward re-optimizes on past data and tests on unseen data (overfit detector); Kelly sizes the best backtested play off its real expectancy. Both are modeled on real Alpaca bars." /></h2>
        <span className="row" style={{ gap: 6 }}>
          <select value={QUANT_UNIVERSE.includes(symbol) ? symbol : ''} onChange={(e) => { if (e.target.value) { setSymbol(e.target.value); setInput(e.target.value); } }}>
            <option value="">— pick —</option>
            {QUANT_UNIVERSE.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} placeholder="symbol" style={{ width: 90 }} />
          <button onClick={apply}>Go</button>
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Analyzing <b>{symbol}</b> — run each tool below (they execute a fresh 1-year backtest).</div>
      <div className="quant-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, alignItems: 'start' }}>
        <WalkForwardPanel symbol={symbol} />
        <KellyPanel symbol={symbol} />
      </div>
    </div>
  );
}
