import { Strategies, SeedStrategies } from '../api/client';
import { Card, Badge, useAsync } from '../components/ui';
import { useState } from 'react';

const CAT_LABEL: Record<string, string> = {
  swing: 'Swing', day: 'Day Trade', 'options-calls': 'Long Calls', 'options-puts': 'Long Puts', ai: 'AI-Driven',
};
const CAT_KIND: Record<string, string> = {
  swing: 'blue', day: 'amber', 'options-calls': 'green', 'options-puts': 'red', ai: 'gray',
};

export default function StrategiesView() {
  const { data } = useAsync<any[]>(Strategies, []);
  const [msg, setMsg] = useState('');
  const list = data || [];
  const cats = [...new Set(list.map((s) => s.category))];

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title={`Strategy Library (${list.length})`} right={
        <button className="primary" onClick={async () => setMsg(JSON.stringify(await SeedStrategies()))}>
          Seed all as bots
        </button>
      }>
        {msg && <div className="muted">Seeded: {msg}</div>}
        <div className="muted">Prebuilt strategies across swings, day trades, long calls, long puts, and AI-driven setups. Seeding creates each as a disabled bot in Observe mode — enable + set a mode per bot on the Bots page.</div>
      </Card>

      {cats.map((cat) => (
        <Card key={cat} title={CAT_LABEL[cat] || cat}>
          <div className="grid cols-2">
            {list.filter((s) => s.category === cat).map((s) => (
              <div key={s.key} className="card" style={{ background: 'var(--panel2)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{s.name}</b>
                  <span className="row" style={{ gap: 4 }}>
                    <Badge kind={CAT_KIND[s.category]}>{CAT_LABEL[s.category]}</Badge>
                    <span className="pill">{s.timeframe}</span>
                    {s.action?.option_type && <Badge kind={s.action.option_type === 'call' ? 'green' : 'red'}>{s.action.option_type}</Badge>}
                  </span>
                </div>
                <div style={{ marginTop: 6 }}>{s.description}</div>
                <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>{s.education}</div>
                {s.ai_gate?.enabled && <div style={{ marginTop: 6 }}><Badge kind="gray">Claude gate ≥ {s.ai_gate.min_conviction}</Badge></div>}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
