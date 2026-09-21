import { exitPulse } from '../exitPulse';

export default function ExitPulseMark({ row, health }: { row: any; health?: any }) {
  const p = exitPulse(row, health?.swingLaw);
  return <span className={`exit-pulse ${p.tone}`} title={p.title}>{p.label}</span>;
}
