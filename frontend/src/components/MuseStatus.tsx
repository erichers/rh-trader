import { MuseStatus as MuseStatusApi, RunWatch } from '../api/client';
import { Badge, fmtDateTime, Info, useAsync } from './ui';
import { useState } from 'react';

function lampClass(configured: boolean, live: boolean | null): string {
  if (configured && live === true) return 'green';
  if (configured) return 'amber';
  return 'gray';
}

function lampLabel(configured: boolean, live: boolean | null): string {
  if (configured && live === true) return 'live';
  if (configured && live === false) return 'probe failed';
  if (configured) return 'configured';
  return 'not configured';
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return 'never';
  return fmtDateTime(iso);
}

/** Muse Spark lamp plus live watch / news / error progress. Polls existing status APIs. */
export default function MuseDesk({ status }: { status?: any }) {
  const remote = useAsync<any>(() => MuseStatusApi(), [], 8000);
  const d = remote.data || status || {};
  const muse = d.muse || status?.muse || {};
  const watch = d.watch || status?.watch || {};
  const [busy, setBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const kind = lampClass(!!muse.configured, muse.live ?? null);
  const now = muse.current;
  const cycle = watch.lastCycle;
  const news = watch.lastNewsPass;
  const perf = watch.lastPerformance;
  const universe: string[] = watch.universe || ['SPY', 'META', 'TSLA', 'QQQ'];

  const runNow = async () => {
    setBusy(true);
    setRunErr(null);
    try {
      await RunWatch();
      remote.reload();
    } catch (e: any) {
      setRunErr(String(e?.message || e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="muse-desk" role="status" aria-label="Muse status and watcher progress">
      <div className="row muse-desk-head">
        <span className="muted muse-k" style={{ margin: 0 }}>Muse<Info topic="muse" /></span>
        <span className={`conn-chip ${kind}`} title={`Muse ${lampLabel(!!muse.configured, muse.live ?? null)} · model ${muse.model || 'muse-spark-1.3'}${muse.lastProbeAt ? ` · probed ${ago(muse.lastProbeAt)}` : ''}${muse.error ? ` · ${muse.error}` : ''}`}>
          <span className="conn-lamp" aria-hidden />
          <span>Muse</span>
          <span className="conn-model">{muse.model || 'muse-spark-1.3'}</span>
        </span>
        <span className="pill">{lampLabel(!!muse.configured, muse.live ?? null)}</span>
        <span className="pill" title="Observe-only watch universe">{universe.join(' · ')}</span>
        <span className="muted" style={{ fontSize: 11 }}>last probe {ago(muse.lastProbeAt)}</span>
        <span className="spacer" />
        <button type="button" disabled={busy || watch.running} onClick={runNow} title="Run one Observe-only watch cycle. Writes notes. No orders.">
          {busy || watch.running ? 'Watching…' : 'Run watch'}
        </button>
      </div>

      <div className="muse-grid">
        <div>
          <div className="muted muse-k">Doing now</div>
          <div className="muse-v">
            {now
              ? <><b>{now.task}</b> {now.model ? <span className="pill">{now.model}</span> : null} <span className="muted">since {ago(now.startedAt)}</span></>
              : watch.current
                ? <><b>{watch.current.phase}</b> {watch.current.symbol ? <span className="pill">{watch.current.symbol}</span> : null} <span className="muted">since {ago(watch.current.startedAt)}</span></>
                : <span className="muted">Idle. Next cycle writes notes only.</span>}
          </div>
        </div>
        <div>
          <div className="muted muse-k">Last watch cycle</div>
          <div className="muse-v">
            {cycle
              ? <>{ago(cycle.at)} · {cycle.notes || 0} notes · {cycle.alerts || 0} alerts · {cycle.learnings || 0} learnings{cycle.error ? <span className="amber"> · {cycle.error}</span> : ''}</>
              : <span className="muted">No cycle yet. Boot runs one after ~20s.</span>}
          </div>
        </div>
        <div>
          <div className="muted muse-k">Last news pass</div>
          <div className="muse-v">
            {news
              ? <>{ago(news.at)} · fetched {news.fetched || 0} · stored {news.stored || 0}{news.error ? <span className="amber"> · {news.error}</span> : ''}</>
              : <span className="muted">Waiting on Alpaca news.</span>}
          </div>
        </div>
        <div>
          <div className="muted muse-k">Errors</div>
          <div className="muse-v">
            {muse.error ? <span className="amber">{muse.error}</span> : null}
            {runErr ? <span className="amber">{runErr}</span> : null}
            {!muse.error && !runErr && (muse.errors?.[0] || watch.errors?.[0])
              ? <span className="amber">{(muse.errors?.[0] || watch.errors?.[0]).detail || (watch.errors?.[0])?.message}</span>
              : null}
            {!muse.error && !runErr && !muse.errors?.length && !watch.errors?.length && <span className="muted">None.</span>}
          </div>
        </div>
      </div>
      {cycle?.symbols?.length ? (
        <div className="watch-uni" aria-label="Watch universe">
          {cycle.symbols.map((s: any) => (
            <div key={s.symbol} className="watch-uni-card">
              <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <a className="symlink" href={`#/ticker/${s.symbol}`} style={{ fontWeight: 700 }}>{s.symbol}</a>
                <Badge kind={s.stance === 'opportunity' ? 'green' : s.stance === 'caution' ? 'amber' : 'gray'}>{s.stance || s.trend || 'watch'}</Badge>
              </div>
              <div className="muse-v muted">{s.error || s.note || 'No note this cycle.'}</div>
            </div>
          ))}
        </div>
      ) : null}
      {perf?.note && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Paper note ({ago(perf.at)}): {perf.note}
        </div>
      )}
    </div>
  );
}
