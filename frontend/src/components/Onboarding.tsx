import { useState } from 'react';

const KEY = 'rh.onboarding.dismissed';

/** First-run / empty-state education. Humble, concrete, one-line chips. */
export default function Onboarding({ force }: { force?: boolean }) {
  const [open, setOpen] = useState(() => {
    if (force) return true;
    try { return localStorage.getItem(KEY) !== '1'; } catch { return true; }
  });
  if (!open) {
    return (
      <div className="onboard-mini">
        <button type="button" className="pill onboard-reopen" onClick={() => setOpen(true)}>How this desk works</button>
      </div>
    );
  }
  const dismiss = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    setOpen(false);
  };
  return (
    <div className="card onboard-card">
      <div className="row onboard-head">
        <h3>Paper desk, Observe mode</h3>
        <button type="button" onClick={dismiss}>Got it</button>
      </div>
      <div className="onboard-grid">
        <div>
          <div className="muted muse-k">Observe vs Paper</div>
          <p>
            Paper is the Alpaca account: fake money, real market data. Observe is the execution
            mode: the desk logs ideas and never sends an order. Cautious would stage an order
            for you to approve. Stay on Paper + Observe while you learn the lamps.
          </p>
        </div>
        <div>
          <div className="muted muse-k">Who does what</div>
          <p>
            Muse handles short watch, ops, and performance notes. NVIDIA then Groq do
            longer research and reviews. Groq also answers chat and sorts news. Kimi is
            backup. Anthropic is optional and the key may be invalid.
          </p>
        </div>
        <div>
          <div className="muted muse-k">The watcher</div>
          <p>
            A loop on SPY, META, TSLA, and QQQ. It pulls news plus simple indicators, asks
            Muse for a short take, and writes alerts, notes, and learnings. It does not place
            orders, even if you flip the mode switch.
          </p>
        </div>
      </div>
    </div>
  );
}
