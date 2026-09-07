import { ModelsStatus } from '../api/client';
import { useAsync } from './ui';

export type ConnChip = {
  id: string;
  label: string;
  configured: boolean;
  live: boolean | null;
  defaultModel?: string | null;
  lastProbeAt?: string | null;
  error?: string | null;
  kind: 'green' | 'amber' | 'gray';
};

function chipTitle(c: ConnChip): string {
  const parts = [c.label];
  if (c.configured && c.live === true) parts.push('live');
  else if (c.configured) parts.push(c.live === false ? 'configured, last probe failed' : 'configured, not probed yet');
  else parts.push('not configured');
  if (c.defaultModel) parts.push(`model ${c.defaultModel}`);
  if (c.lastProbeAt) {
    const t = new Date(c.lastProbeAt);
    if (!isNaN(t.getTime())) parts.push(`probed ${t.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT`);
  }
  if (c.error) parts.push(c.error);
  return parts.join(' · ');
}

function Chip({ c }: { c: ConnChip }) {
  return (
    <span className={`conn-chip ${c.kind}`} title={chipTitle(c)}>
      <span className="conn-lamp" aria-hidden />
      <span>{c.label}</span>
      {c.defaultModel ? <span className="conn-model">{c.defaultModel}</span> : null}
    </span>
  );
}

/** Trading-desk connection lamps. Green = key + live probe, amber = key but not live, gray = no key.
 *  Anthropic / Local are omitted by the API unless that probe is live. */
export default function ConnectionStrip({ status }: { status?: any }) {
  const remote = useAsync<any>(() => ModelsStatus(), [], 30000);
  const d = remote.data || status;
  const chips: ConnChip[] = d?.chips || [];
  const loading = !d && remote.loading;

  return (
    <div className="conn-strip" role="status" aria-label="Provider connections">
      <span className="conn-legend">Connections</span>
      {loading && <span className="muted" style={{ fontSize: 11 }}>probing…</span>}
      {remote.err && !chips.length && <span className="amber" style={{ fontSize: 11 }} title={remote.err}>status unavailable</span>}
      {chips.map((c) => <Chip key={c.id} c={c} />)}
      {d?.corpus && (
        <span className="conn-corpus muted" title="Rows currently in MySQL">
          {d.corpus.news} news · {d.corpus.learnings} learnings · {d.corpus.learning_runs} runs
        </span>
      )}
    </div>
  );
}
