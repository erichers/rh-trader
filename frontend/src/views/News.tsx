import { useState } from 'react';
import { News, NewsRefresh } from '../api/client';
import { Card, useAsync } from '../components/ui';

export default function NewsView() {
  const { data, reload } = useAsync<any[]>(() => News(), [], 600000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const rows = data || [];

  const refresh = async () => {
    setBusy(true);
    try { const r: any = await NewsRefresh(); setMsg(`fetched ${r.fetched}, ${r.stored} new`); reload(); }
    catch (e: any) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Card title={`Market News (${rows.length})`} right={
      <div className="row">
        {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
        <button className="primary" onClick={refresh} disabled={busy}>{busy ? 'Fetching…' : 'Refresh real news'}</button>
      </div>
    }>
      <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
        Real, live headlines from the Alpaca news feed for your watchlist symbols. No sample data.
      </div>
      {rows.length === 0 ? (
        <div className="muted">No news stored yet — click “Refresh real news” (auto-refreshes every 10 min).</div>
      ) : (
        rows.map((n) => (
          <div key={n.id} className="card" style={{ background: 'var(--panel2)', marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{n.symbol || '—'}</b>
              <span className="muted" style={{ fontSize: 11 }}>{n.source} · {n.published_at ? new Date(n.published_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : ''}</span>
            </div>
            <div style={{ marginTop: 4 }}>{n.headline}</div>
            {n.summary && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{String(n.summary).slice(0, 240)}</div>}
            {n.url && <a href={n.url} target="_blank" rel="noreferrer">read →</a>}
          </div>
        ))
      )}
    </Card>
  );
}
