// Dependency-free SVG charts, restyled to the Robinhood aesthetic:
// a single thin smooth line, directional green/red color, and a soft
// gradient area fill that fades from a faint tint of the line color to
// fully transparent. Minimal axes/labels, lots of breathing room.

const W = 1000;
const H = 280;
const PAD = 8;

// Robinhood signature up/down colors. Kept in sync with the design system's
// green/red semantics; these exact hexes match the Robinhood look.
const RH_GREEN = '#00C805';
const RH_RED = '#FF5000';

// Unique id helper so multiple charts on one page don't share <defs>.
let gradSeq = 0;
function nextGradId(prefix: string): string {
  gradSeq += 1;
  return `${prefix}-${gradSeq}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Build a smooth (Catmull-Rom -> cubic Bézier) path through the given points.
// Falls back to a straight move for <2 points. Tension kept gentle so the line
// reads as a clean Robinhood curve without overshooting.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

export function PriceChart({
  series, trades, height = 300,
}: {
  series: { t: number; c: number }[];
  trades: { entry_date?: string; exit_date?: string; ret: number }[];
  height?: number;
}) {
  if (!series || series.length < 2) return <div className="muted">No price data.</div>;
  const cs = series.map((s) => s.c);
  const min = Math.min(...cs), max = Math.max(...cs);
  const span = max - min || 1;
  const n = series.length;
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (c: number) => PAD + (1 - (c - min) / span) * (H - 2 * PAD);
  const pts = series.map((s, i) => ({ x: x(i), y: y(s.c) }));
  const line = smoothPath(pts);
  const baseY = H - PAD; // fill floor
  const area = `${line} L${x(n - 1).toFixed(1)},${baseY.toFixed(1)} L${x(0).toFixed(1)},${baseY.toFixed(1)} Z`;
  const iso = series.map((s) => new Date(s.t).toISOString().slice(0, 10));
  const findIdx = (d?: string) => (d ? iso.indexOf(d) : -1);

  // Direction: gain (end >= start) -> green, loss -> red.
  const up = series[n - 1].c >= series[0].c;
  const color = up ? RH_GREEN : RH_RED;
  const gradId = nextGradId('rh-price-fill');
  const startY = y(series[0].c); // baseline at the starting price (RH touch)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Faint dashed baseline at the starting price */}
      <line x1={PAD} y1={startY} x2={W - PAD} y2={startY}
        stroke="var(--border, #232a34)" strokeWidth={1} strokeDasharray="2 5"
        vectorEffect="non-scaling-stroke" opacity={0.7} />

      {/* Soft gradient area fill beneath the line */}
      <path d={area} fill={`url(#${gradId})`} stroke="none" />

      {/* Single thin smooth Robinhood line */}
      <path d={line} fill="none" stroke={color} strokeWidth={1.8}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

      {trades.map((t, k) => {
        const ei = findIdx(t.entry_date), xi = findIdx(t.exit_date);
        return (
          <g key={k}>
            {ei >= 0 && <circle cx={x(ei)} cy={y(series[ei].c)} r={3.5} fill={RH_GREEN} />}
            {xi >= 0 && <circle cx={x(xi)} cy={y(series[xi].c)} r={3.5} fill={t.ret >= 0 ? RH_GREEN : RH_RED} />}
            {ei >= 0 && xi >= 0 && (
              <line x1={x(ei)} y1={y(series[ei].c)} x2={x(xi)} y2={y(series[xi].c)}
                stroke={t.ret >= 0 ? 'rgba(0,200,5,.45)' : 'rgba(255,80,0,.45)'} strokeWidth={1}
                strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </g>
        );
      })}

      <text x={PAD} y={14} fill="var(--muted, #8b95a5)" fontSize={11}>${max.toFixed(2)}</text>
      <text x={PAD} y={H - 4} fill="var(--muted, #8b95a5)" fontSize={11}>${min.toFixed(2)}</text>
      <text x={W - PAD} y={H - 4} fill="var(--muted, #8b95a5)" fontSize={11} textAnchor="end">{fmtDate(series[n - 1].t)}</text>
      <text x={PAD + 60} y={H - 4} fill="var(--muted, #8b95a5)" fontSize={11}>{fmtDate(series[0].t)}</text>
    </svg>
  );
}

export function EquityChart({ curve, dates, height = 160, unit = '$' }: { curve: number[]; dates?: number[]; height?: number; unit?: string }) {
  if (!curve || curve.length < 2) return <div className="muted">No equity curve.</div>;
  const min = Math.min(...curve), max = Math.max(...curve);
  const span = max - min || 1;
  const n = curve.length;
  const h = 200;
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (h - 2 * PAD);
  const pts = curve.map((v, i) => ({ x: x(i), y: y(v) }));
  const line = smoothPath(pts);
  const baseY = h - PAD;
  const area = `${line} L${x(n - 1).toFixed(1)},${baseY.toFixed(1)} L${x(0).toFixed(1)},${baseY.toFixed(1)} Z`;
  const up = curve[curve.length - 1] >= curve[0];
  const color = up ? RH_GREEN : RH_RED;
  const startY = y(curve[0]);
  const gradId = nextGradId('rh-equity-fill');

  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Faint dashed baseline at the starting equity */}
      <line x1={PAD} y1={startY} x2={W - PAD} y2={startY}
        stroke="var(--border, #232a34)" strokeWidth={1} strokeDasharray="2 5"
        vectorEffect="non-scaling-stroke" opacity={0.7} />

      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

      <text x={PAD} y={14} fill="var(--muted, #8b95a5)" fontSize={11}>{unit}{max.toFixed(0)}</text>
      <text x={PAD} y={h - 4} fill="var(--muted, #8b95a5)" fontSize={11}>{unit}{min.toFixed(0)}</text>
      {dates && dates.length === n && (
        <>
          <text x={PAD + 50} y={h - 4} fill="var(--muted, #8b95a5)" fontSize={11}>{fmtDate(dates[0])}</text>
          <text x={W - PAD} y={h - 4} fill="var(--muted, #8b95a5)" fontSize={11} textAnchor="end">{fmtDate(dates[n - 1])}</text>
        </>
      )}
    </svg>
  );
}

/** Compact account sparkline: one thin directional line plus the signature gradient
 *  fade, no axes and no labels, sized for the header strip. Direction (and therefore
 *  color) is measured end vs start of the slice being drawn, so it always agrees with
 *  the P/L number shown beside it. */
export function Sparkline({
  points, height = 48, baseline = true, up: upOverride,
}: {
  points: { t: number; equity: number }[];
  height?: number;
  baseline?: boolean;
  /** Force the direction color. Pass the sign of the P/L figure shown next to the
   *  chart so the two can never disagree (a window's baseline is not always the
   *  first drawn point). Omit to color by end-vs-start of the drawn slice. */
  up?: boolean;
}) {
  if (!points || points.length < 2) return null;
  const vs = points.map((p) => p.equity);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const n = points.length;
  const h = 100;
  const pad = 6;
  const x = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - 2 * pad);
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.equity) }));
  const line = smoothPath(pts);
  const area = `${line} L${x(n - 1).toFixed(1)},${(h - pad).toFixed(1)} L${x(0).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const up = upOverride ?? (vs[n - 1] >= vs[0]);
  const color = up ? RH_GREEN : RH_RED;
  const gradId = nextGradId('rh-spark-fill');

  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" aria-hidden="true"
      style={{ width: '100%', height, display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {baseline && (
        <line x1={pad} y1={y(vs[0])} x2={W - pad} y2={y(vs[0])}
          stroke="var(--border-strong, #232a34)" strokeWidth={1} strokeDasharray="2 5"
          vectorEffect="non-scaling-stroke" opacity={0.65} />
      )}
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
