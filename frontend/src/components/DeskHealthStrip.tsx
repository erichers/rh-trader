import { deskHealth, stripTone } from '../deskHealth';

/** Sticky one-liner. Color comes from desk health, never from day P/L. */
export default function DeskHealthStrip({
  health,
  apiDown,
  monitors,
}: {
  health: any;
  apiDown: boolean;
  monitors?: any[] | null;
}) {
  const d = deskHealth(health, apiDown);
  const tone = stripTone(health, apiDown, monitors);
  return (
    <div className={`desk-health tone-${tone}`} role="status" aria-label="Desk health" title={d.line}>
      <span className="desk-health-line">{d.line}</span>
    </div>
  );
}
