import { useState } from 'react';
import { Chat, Agent } from '../api/client';
import { Card } from '../components/ui';
import { Icon } from '../components/icons';

type Msg = { role: 'user' | 'assistant'; text: string; meta?: string };

// Prebuilt data questions (Groq text-to-SQL over your DB).
const DATA_PILLS = [
  'How many bots are enabled and what modes are they in?',
  'Show my last 10 orders with status and source',
  'Which symbols were vetoed most by the risk engine?',
  'My biggest positions by market value',
  'Which bots fired the most signals?',
  'Recent risk events and why they were vetoed',
  'Total realized P/L from filled orders',
  'What does my watchlist look like with latest research?',
];

// Prebuilt agent prompts (Kimi — can propose risk-gated bots/trades).
const AGENT_PILLS = [
  'Suggest a high-conviction options bot for AMD and explain why',
  'Review my open positions and flag anything risky',
  'What swing setup looks best across QQQ, SPY, TSLA right now?',
  'Propose 3 bots for this week and their risk settings',
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
      const m = /api key|provider/i.test(String(e)) ? 'No AI provider configured — set META_MUSE_API_KEY / GROQ_API_KEY / KIMI_API_KEY in .env.' : String(e);
      setLog((l) => [...l, { role: 'assistant', text: m }]);
    } finally {
      setBusy(false);
    }
  };

  const askAgent = (q: string) => { setAgentMode(true); send(q, true); };

  return (
    <Card title={agentMode ? 'Trade Agent (AI proposes risk-gated orders — Kimi)' : 'Ask AI (Vanna text-to-SQL over your data — Groq)'}>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row"><input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} /> Agent mode</label>
        {agentMode && (
          <label className="row"><input type="checkbox" checked={allowOpenNew} onChange={(e) => setAllowOpenNew(e.target.checked)} /> Allow opening new positions</label>
        )}
        <span className="muted">Orders still pass the risk engine + current global mode.</span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="muted icon-btn" style={{ fontSize: 11, marginBottom: 4 }}><Icon name="chart" size={14} /> Ask about your data:</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {DATA_PILLS.map((q) => (
            <button key={q} className="pill" style={{ cursor: 'pointer' }} disabled={busy} onClick={() => send(q, false)}>{q}</button>
          ))}
        </div>
        <div className="muted icon-btn" style={{ fontSize: 11, margin: '8px 0 4px' }}><Icon name="bot" size={14} /> Ask the agent (suggests bots & trades):</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {AGENT_PILLS.map((q) => (
            <button key={q} className="pill" style={{ cursor: 'pointer', borderColor: 'var(--accent)' }} disabled={busy} onClick={() => askAgent(q)}>{q}</button>
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
