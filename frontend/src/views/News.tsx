import { useState } from 'react';
import { News, NewsRefresh } from '../api/client';
import { Card, Badge, Sym, useAsync } from '../components/ui';
import ConnectionStrip from '../components/Connections';

function sentimentKind(v: any): string | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0.15) return 'green';
  if (n < -0.15) return 'red';
  return 'gray';
}

export default function NewsView() {
  const { data, err, loading, reload } = useAsync<any[]>(() => News(), [], 600000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const rows = Array.isArray(data) ? data : [];

  const refresh = async () => {
    setBusy(true);
    try { const r: any = await NewsRefresh(); setMsg(`fetched ${r.fetched}, ${r.stored} new`); reload(); }
    catch (e: any) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ display: 'grid', gap: 14 }}>
      <ConnectionStrip />
      <Card title={`Market News (${rows.length})`} right={
        <div className="row">
          {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
          <button className="primary" onClick={refresh} disabled={busy}>{busy ? 'Fetching…' : 'Refresh real news'}</button>
        </div>
      }>
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
          Headlines from the MySQL <code>news</code> table (Alpaca feed). Newest first. No sample data.
        </div>
        {err && <div className="red" style={{ marginBottom: 10, fontSize: 12 }}>{err}</div>}
        {loading && !rows.length ? (
          <div className="muted">Loading stored headlines…</div>
        ) : rows.length === 0 ? (
          <div className="muted">No rows in <code>news</code> yet — click “Refresh real news” (auto-refreshes every 10 min) or import history into the DB.</div>
        ) : (
          rows.map((n) => {
            const sent = sentimentKind(n.sentiment);
            return (
              <div key={n.id || n.ext_id || `${n.symbol}-${n.published_at}`} className="card" style={{ background: 'var(--panel2)', marginBottom: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{n.symbol ? <Sym bold>{n.symbol}</Sym> : <b>—</b>}{sent && <Badge kind={sent}>{Number(n.sentiment) > 0 ? '+' : ''}{Number(n.sentiment).toFixed(2)}</Badge>}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{n.source || 'news'} · {n.published_at || n.created_at ? new Date(n.published_at || n.created_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : ''}</span>
                </div>
                <div style={{ marginTop: 4 }}>{n.headline}</div>
                {n.summary && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>{String(n.summary).slice(0, 240)}</div>}
                {n.url && <a href={n.url} target="_blank" rel="noreferrer">read →</a>}
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
