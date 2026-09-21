/**
 * Elegant Jev fallback when TypeSafe is degraded / out of prepaid credits.
 * Local decide.ts Choice/Score — never crashes the desk, never blocks market open.
 * Optional one-shot Kimi/Groq `review` yes/no (best-effort).
 */

import { choice, score } from './decide.js';
import {
  composeJevEntry,
  parseJevPick,
  type JevEntryMode,
  type JevEntryState,
  type JevPanelAnswers,
} from './jev.js';

export type LocalJevResult = {
  panel: JevPanelAnswers;
  pick: ReturnType<typeof composeJevEntry>['pick'];
  failOpen: boolean;
  because: string;
  via: 'local_decide' | 'local_decide+llm';
};

function checksLookFresh(state: JevEntryState): boolean {
  const why = String(state.signal_why || state.why || '');
  if (/already >|no fresh|stale|already positive/i.test(why)) return false;
  return true;
}

export function localJevPanel(state: JevEntryState): JevPanelAnswers {
  const fresh = checksLookFresh(state);
  const open = Number(state.open_positions_count);
  const crowded = Number.isFinite(open) && open >= 8;
  const quality = fresh ? (crowded ? 1.0 : 1.6) : 0.4;
  return {
    signal_coherent: fresh ? 0.82 : 0.35,
    action: {
      choice: fresh ? (crowded ? 'size_down' : 'enter') : 'skip',
      confidence: 0.80,
    },
    setup_quality: { score: quality, confidence: 0.7 },
    too_crowded_same_day: crowded ? 0.78 : 0.18,
  };
}

/** Proof the local primitives still shape a panel (used in because / logs). */
export function localJevEvidence(state: JevEntryState) {
  const panel = localJevPanel(state);
  const rails = choice({
    id: 'fallback_rails',
    options: ['hold', 'review'] as const,
    pick: 'review',
    because: 'TypeSafe degraded: local Choice/Score panel',
    evidence: { symbol: state.symbol, dte: state.dte_or_leaps ?? state.dte },
  });
  const q = score({
    id: 'fallback_quality',
    levels: ['weak', 'ok', 'strong'],
    value: panel.setup_quality?.score ?? 1,
    because: 'local setup_quality',
  });
  return { rails, quality: q, panel };
}

export function composeLocalJev(state: JevEntryState, mode: JevEntryMode): LocalJevResult {
  const panel = localJevPanel(state);
  const composed = composeJevEntry(panel, mode);
  return {
    panel,
    pick: composed.pick,
    failOpen: mode === 'shadow' ? true : composed.failOpen,
    because: `jev fallback (local decide): ${composed.because}`,
    via: 'local_decide',
  };
}

export async function optionalLlmYesNo(
  state: JevEntryState,
  ask: (system: string, user: string) => Promise<{ go?: boolean; because?: string }>,
): Promise<{ go: boolean; because: string } | null> {
  try {
    const out = await ask(
      'You are a one-line paper-desk reviewer. Answer JSON only. Never place an order.',
      JSON.stringify({
        question: 'Is this a reasonable long-call add given the packet? yes/no.',
        symbol: state.symbol,
        why: state.signal_why || state.why,
        dte_or_leaps: state.dte_or_leaps ?? state.dte,
        output_shape: { go: true, because: 'one line' },
      }),
    );
    if (!out || typeof out.go !== 'boolean') return null;
    return { go: out.go, because: String(out.because || 'llm review').slice(0, 160) };
  } catch {
    return null;
  }
}

export async function fallbackJevGate(
  state: JevEntryState,
  mode: JevEntryMode,
  deps: { llmReview?: (system: string, user: string) => Promise<{ go?: boolean; because?: string }> } = {},
): Promise<LocalJevResult> {
  const local = composeLocalJev(state, mode);
  if (!deps.llmReview) return local;
  const llm = await optionalLlmYesNo(state, deps.llmReview);
  if (!llm) return local;
  if (!llm.go && mode === 'active') {
    return {
      ...local,
      pick: 'skip',
      failOpen: false,
      because: `jev fallback (local+llm skip): ${llm.because}`,
      via: 'local_decide+llm',
    };
  }
  return {
    ...local,
    because: `${local.because}; llm ${llm.go ? 'yes' : 'no'} (${llm.because})`,
    via: 'local_decide+llm',
  };
}

export { parseJevPick };
