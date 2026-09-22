import { nextAction } from '../deskHealth';

/** One verb. Quiet when the rails are holding. Red when a sell is stuck. */
export default function NextActionChip({
  health,
  apiDown,
  monitors,
}: {
  health: any;
  apiDown: boolean;
  monitors?: any[] | null;
}) {
  const a = nextAction(health, apiDown, monitors);
  const body = a.href ? <a href={a.href}>{a.label}</a> : <span>{a.label}</span>;
  return (
    <div className={`next-action tone-${a.tone}`} role="status" aria-label="Next action">
      {body}
    </div>
  );
}
