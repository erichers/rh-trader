import type { CSSProperties, ReactNode } from 'react';

export type GlassTone = 'default' | 'warn' | 'danger';

/** Frosted panel. One shadow. Health tones stay off the P&L green/red tokens. */
export default function GlassCard({
  title,
  right,
  tone = 'default',
  padding,
  children,
}: {
  title?: ReactNode;
  right?: ReactNode;
  tone?: GlassTone;
  padding?: CSSProperties['padding'];
  children: ReactNode;
}) {
  const toneClass = tone === 'default' ? '' : ` tone-${tone}`;
  return (
    <section className={`glass-card${toneClass}`} style={padding != null ? { padding } : undefined}>
      {(title || right) && (
        <div className="row glass-card-head">
          {title ? <h3>{title}</h3> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}
