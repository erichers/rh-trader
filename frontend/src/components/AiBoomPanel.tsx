import { Badge } from './ui';
import { aiBoomView, badgeKind } from '../aiBoomPack';

/** Fox wait-for-signal pack. Badges come from the server census, with a local fallback. */
export default function AiBoomPanel({ aiBoom }: { aiBoom?: unknown }) {
  const view = aiBoomView(aiBoom);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <b>Fox wait for signal</b>
        <span className="muted" style={{ fontSize: 12 }}>paper only, default off</span>
      </div>
      <p className="muted" style={{ margin: '8px 0', fontSize: 13, lineHeight: 1.45 }}>{view.note}</p>
      <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.45 }}>{view.prior}</p>
      {view.deferred.length > 0 && (
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>Deferred, not bots: {view.deferred.join(', ')}.</p>
      )}
      {view.skipped.length > 0 && (
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>Not added again: {view.skipped.join(', ')}.</p>
      )}
      <div className="grid" style={{ gap: 10 }}>
        {view.packs.map((pack) => (
          <div key={pack.id} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--panel2)', border: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <b>{pack.name}</b>
              <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {pack.badges.map((badge) => <Badge key={badge} kind={badgeKind(badge)}>{badge}</Badge>)}
              </span>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{pack.symbols.join(', ')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
