import { deskHealth } from '../deskHealth';

/** Sticky line under the paper badge. P&L stays on the account strip. */
export default function DeskHealthStrip({ health, apiDown }: { health: any; apiDown: boolean }) {
  const d = deskHealth(health, apiDown);
  return (
    <div className={`desk-health${d.readyOk ? '' : ' warn'}`} role="status" aria-label="Desk health">
      <span className={d.readyOk ? 'ok' : 'bad'}>{d.ready}</span>
      <span>{d.exits}</span>
      <span>{d.jev}</span>
      <span>{d.muse}</span>
    </div>
  );
}
