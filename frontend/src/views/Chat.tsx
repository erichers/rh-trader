import { useState } from 'react';
import { Chat, Agent } from '../api/client';
import { Card } from '../components/ui';
import { Icon } from '../components/icons';

type Msg = { role: 'user' | 'assistant'; text: string; meta?: string };

// Short labels stay one line. Full prompt goes on send.
const DATA_PILLS: { label: string; q: string }[] = [
  { label: 'Enabled bots', q: 'How many bots are enabled and what modes are they in?' },
  { label: 'Last 10 orders', q: 'Show my last 10 orders with status and source' },
  { label: 'Most vetoed', q: 'Which symbols were vetoed most by the risk engine?' },
  { label: 'Biggest positions', q: 'My biggest positions by market value' },
  { label: 'Hottest bots', q: 'Which bots fired the most signals?' },
  { label: 'Risk events', q: 'Recent risk events and why they were vetoed' },
  { label: 'Realized P/L', q: 'Total realized P/L from filled orders' },
  { label: 'Watch + research', q: 'What does my watchlist look like with latest research?' },
];

const AGENT_PILLS: { label: string; q: string }[] = [
  { label: 'AMD options bot', q: 'Suggest a high-conviction options bot for AMD and explain why' },
  { label: 'Review positions', q: 'Review my open positions and flag anything risky' },
  { label: 'Best swing now', q: 'What swing setup looks best across QQQ, SPY, TSLA right now?' },
  { label: '3 bots this week', q: 'Propose 3 bots for this week and their risk settings' },
];

export default function ChatView() {
  const [log, setLog] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [agentMode, setAgentMode] = useState(false);
  const [allowOpenNew, setAllowOpenNew] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async (override?: string, forceAgent?: boolean) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    const useAgent = forceAgent ?? agentMode;
    setInput('');
    setLog((l) => [...l, { role: 'user', text }]);
    setBusy(true);
    try {
      if (useAgent) {
        const r = await Agent(text, allowOpenNew);
        const acts = (r.actions || []).map((a: any) => `• ${a.action}/${a.status}: ${a.reason}`).join('\n');
        setLog((l) => [...l, { role: 'assistant', text: r.answer, meta: acts || undefined }]);
      } else {
        const r = await Chat(text);
        setLog((l) => [...l, { role: 'assistant', text: r.answer }]);
      }
    } catch (e: any) {
      const m = /api key|provider/i.test(String(e)) ? 'No AI provider configured. Set GROQ_API_KEY, NVIDIA_API_KEY, or META_MUSE_API_KEY in .env.' : String(e);
      setLog((l) => [...l, { role: 'assistant', text: m }]);
    } finally {
      setBusy(false);
    }
  };

  const askAgent = (q: string) => { setAgentMode(true); send(q, true); };

  return (
    <Card title={agentMode ? 'Trade agent (Muse first, risk engine still decides)' : 'Ask AI (Groq text-to-SQL over your data)'}>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row"><input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} /> Agent mode</label>
        {agentMode && (
          <label className="row"><input type="checkbox" checked={allowOpenNew} onChange={(e) => setAllowOpenNew(e.target.checked)} /> Allow opening new positions</label>
        )}
        <span className="muted">Orders still pass the risk engine + current global mode.</span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="muted icon-btn" style={{ fontSize: 11, marginBottom: 4 }}><Icon name="chart" size={14} /> Ask about your data (Groq)</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {DATA_PILLS.map((p) => (
            <button key={p.label} className="pill" style={{ cursor: 'pointer' }} disabled={busy} title={p.q} onClick={() => send(p.q, false)}>{p.label}</button>
          ))}
        </div>
        <div className="muted icon-btn" style={{ fontSize: 11, margin: '8px 0 4px' }}><Icon name="bot" size={14} /> Ask the agent (Muse)</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {AGENT_PILLS.map((p) => (
            <button key={p.label} className="pill" style={{ cursor: 'pointer', borderColor: 'var(--accent)' }} disabled={busy} title={p.q} onClick={() => askAgent(p.q)}>{p.label}</button>
          ))}
        </div>
      </div>

      <div className="chat-log" style={{ minHeight: 200, marginBottom: 12 }}>
        {log.length === 0 && <div className="muted">Tap a pill above, or type your own question.</div>}
        {log.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
            {m.meta && <div className="muted" style={{ marginTop: 6, fontSize: 11, whiteSpace: 'pre-wrap' }}>{m.meta}</div>}
          </div>
        ))}
        {busy && <div className="bubble assistant muted">thinking…</div>}
      </div>

      <div className="row">
        <input
          style={{ flex: 1 }}
          placeholder="Message AI…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="primary" onClick={() => send()} disabled={busy}>Send</button>
      </div>
    </Card>
  );
}
