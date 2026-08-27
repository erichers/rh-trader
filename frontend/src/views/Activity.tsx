import { useState } from 'react';
import { RiskEvents, Signals, Audit } from '../api/client';
import { Card, Badge, useAsync, Sym, fmtDateTime } from '../components/ui';

export default function Activity() {
  const [tab, setTab] = useState<'risk' | 'signals' | 'audit'>('risk');
  // Only the visible tab polls — don't triple backend load for data the user can't see.
  const risk = useAsync<any[]>(RiskEvents, [tab], tab === 'risk' ? 8000 : undefined);
  const signals = useAsync<any[]>(Signals, [tab], tab === 'signals' ? 8000 : undefined);
  const audit = useAsync<any[]>(Audit, [tab], tab === 'audit' ? 8000 : undefined);

  return (
    <Card title="Activity & Risk" right={
      <div className="mode-seg">
        <button className={tab === 'risk' ? 'on observe' : ''} onClick={() => setTab('risk')}>Risk</button>
        <button className={tab === 'signals' ? 'on observe' : ''} onClick={() => setTab('signals')}>Signals</button>
        <button className={tab === 'audit' ? 'on observe' : ''} onClick={() => setTab('audit')}>Audit</button>
      </div>
    }>
      {tab === 'risk' && (
        <table>
          <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Decision</th><th>Reason</th></tr></thead>
          <tbody>
            {(risk.data || []).map((r) => (
              <tr key={r.id}>
                <td className="muted">{fmtDateTime(r.created_at)}</td>
                <td><Sym bold>{r.symbol}</Sym></td><td>{r.side}</td><td>{r.qty}</td>
                <td><Badge kind={r.decision === 'allow' ? 'green' : 'red'}>{r.decision}</Badge></td>
                <td className="muted" style={{ fontSize: 11 }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'signals' && (
        <table>
          <thead><tr><th>Time</th><th>Bot</th><th>Symbol</th><th>TF</th><th>Fired</th></tr></thead>
          <tbody>
            {(signals.data || []).map((s) => (
              <tr key={s.id}>
                <td className="muted">{fmtDateTime(s.created_at)}</td>
                <td>#{s.bot_id}</td><td><Sym bold>{s.symbol}</Sym></td><td>{s.timeframe}</td>
                <td><Badge kind={s.fired ? 'green' : 'gray'}>{s.fired ? 'fired' : 'no'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'audit' && (
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
          <tbody>
            {(audit.data || []).map((a) => (
              <tr key={a.id}>
                <td className="muted">{fmtDateTime(a.created_at)}</td>
                <td><span className="pill">{a.type}</span></td>
                <td>{a.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
