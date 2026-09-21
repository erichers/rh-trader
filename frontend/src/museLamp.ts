/** Muse lamp. Green only while a cycle is running. Idle and waiting stay off green. */

export type MuseLamp = {
  kind: 'green' | 'amber' | 'gray';
  text: string;
  dot: 'green' | 'amber' | 'gray';
};

export function museLamp(w: {
  mode?: string | null;
  running?: boolean | null;
  lastCycle?: string | null;
  lastError?: string | null;
} | null | undefined): MuseLamp {
  const mode = w?.mode === 'observe' ? 'observe' : 'improve';
  if (w?.lastError) return { kind: 'amber', dot: 'amber', text: `${mode} · error` };
  if (w?.running) return { kind: 'green', dot: 'green', text: `${mode} · running` };
  if (mode === 'observe') return { kind: 'gray', dot: 'gray', text: 'observe' };
  const state = w?.lastCycle ? 'idle' : 'waiting';
  return { kind: 'gray', dot: 'gray', text: `${mode} · ${state}` };
}
