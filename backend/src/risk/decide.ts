/**
 * Local TypeSafe / System One decision primitives (Choice + Score).
 *
 * Pattern only — no TypeSafe API, no paid SDK. A go/no-go is a structured
 * Decision over typed state: each question is a Choice (closed option set)
 * or a Score (ordered rubric). Missing / unknown answers fail closed.
 *
 * Confidence matches the documented Choice formula:
 *   c = (pmax − 1/K) / (1 − 1/K)
 * i.e. how far the leading option sits above a uniform prior. Confidence is
 * not correctness; thresholds live in this file, not in a model.
 */

export type Evidence = Record<string, string | number | boolean | null | undefined>;

export type ChoiceAnswer<T extends string = string> = {
  kind: 'choice';
  id: string;
  choice: T;
  confidence: number;
  probabilities: Record<T, number>;
  because: string;
  evidence: Evidence;
};

export type ScoreAnswer = {
  kind: 'score';
  id: string;
  score: number;
  confidence: number;
  levels: string[];
  because: string;
  evidence: Evidence;
};

export type Answer = ChoiceAnswer<string> | ScoreAnswer;

export type Decision = {
  go: boolean;
  confidence: number;
  because: string;
  answers: Answer[];
};

/** Distance of the leading mass from a uniform K-way prior, clamped to [0, 1]. */
export function choiceConfidence(pMax: number, k: number): number {
  if (!(k > 1)) return 1;
  const c = (pMax - 1 / k) / (1 - 1 / k);
  if (!Number.isFinite(c)) return 0;
  return Math.min(1, Math.max(0, c));
}

function asIds<T extends string>(options: readonly T[] | readonly { id: T; label?: string }[]): T[] {
  return options.map((o) => (typeof o === 'string' ? o : o.id));
}

/**
 * A Choice: pick one option from a closed set. `mass` is optional per-option
 * unnormalized weight (default: 1 on `pick`, 0 elsewhere).
 */
export function choice<T extends string>(opts: {
  id: string;
  options: readonly T[] | readonly { id: T; label?: string }[];
  pick: T;
  mass?: Partial<Record<T, number>>;
  because: string;
  evidence?: Evidence;
}): ChoiceAnswer<T> {
  const ids = asIds(opts.options);
  const raw: Record<string, number> = {};
  let total = 0;
  for (const id of ids) {
    const given = opts.mass?.[id as T];
    const n = given != null && Number.isFinite(Number(given)) ? Math.max(0, Number(given)) : (id === opts.pick ? 1 : 0);
    raw[id] = n;
    total += n;
  }
  const probabilities = {} as Record<T, number>;
  let pMax = 0;
  for (const id of ids) {
    const p = total > 0 ? raw[id] / total : 1 / ids.length;
    probabilities[id as T] = p;
    if (p > pMax) pMax = p;
  }
  const pick = ids.includes(opts.pick) ? opts.pick : ids[ids.length - 1];
  return {
    kind: 'choice',
    id: opts.id,
    choice: pick,
    confidence: choiceConfidence(pMax, ids.length),
    probabilities,
    because: opts.because,
    evidence: opts.evidence || {},
  };
}

/**
 * A Score: place evidence on an ordered rubric. `value` is a level index
 * (0..n-1) and may be fractional. Confidence is how close we sit to a
 * whole level (1 at an integer, 0 at the midpoint).
 */
export function score(opts: {
  id: string;
  levels: readonly string[];
  value: number;
  because: string;
  evidence?: Evidence;
}): ScoreAnswer {
  const n = opts.levels.length;
  const max = Math.max(0, n - 1);
  const v = Number.isFinite(opts.value) ? Math.min(max, Math.max(0, opts.value)) : 0;
  const nearest = Math.round(v);
  const conf = n <= 1 ? 1 : 1 - Math.min(1, Math.abs(v - nearest) * 2);
  return {
    kind: 'score',
    id: opts.id,
    score: v,
    confidence: conf,
    levels: [...opts.levels],
    because: opts.because,
    evidence: opts.evidence || {},
  };
}

export const UNKNOWN = 'unknown';
export const PASS = 'pass';
export const FAIL = 'fail';

/** Closed three-way gate used by most risk questions. */
export const GATE_OPTIONS = [PASS, FAIL, UNKNOWN] as const;
export type GatePick = (typeof GATE_OPTIONS)[number];

export function gate(opts: {
  id: string;
  pick: GatePick;
  because: string;
  evidence?: Evidence;
}): ChoiceAnswer<GatePick> {
  return choice({ ...opts, options: GATE_OPTIONS });
}

/**
 * Fail-closed go/no-go. Any Choice whose pick is `fail` or `unknown`
 * (or not in `goWhen`) vetoes. Any Score below its floor vetoes.
 * Missing answers are the caller's responsibility — pass them as `unknown`.
 */
export function decideGo(opts: {
  answers: readonly Answer[];
  /** Question id → the only Choice value that is a go. Default: `pass`. */
  goWhen?: Record<string, string>;
  /** Question id → minimum Score (inclusive). */
  scoreFloors?: Record<string, number>;
  minConfidence?: number;
}): Decision {
  const goWhen = opts.goWhen || {};
  const floors = opts.scoreFloors || {};
  const minC = opts.minConfidence ?? 0;
  const vetoes: string[] = [];
  let confMin = 1;

  for (const a of opts.answers) {
    confMin = Math.min(confMin, a.confidence);
    if (a.kind === 'choice') {
      const need = goWhen[a.id] ?? PASS;
      if (a.choice === UNKNOWN || a.choice !== need) {
        vetoes.push(`${a.id}: ${a.because}`);
      }
    } else {
      const floor = floors[a.id];
      if (floor != null && a.score < floor) {
        vetoes.push(`${a.id}: ${a.because}`);
      }
    }
  }

  if (confMin < minC) {
    vetoes.push(`confidence ${confMin.toFixed(2)} < ${minC} — fail-closed`);
  }

  return {
    go: vetoes.length === 0,
    confidence: vetoes.length ? 0 : confMin,
    because: vetoes.length ? vetoes.join('; ') : opts.answers.map((a) => a.because).join('; '),
    answers: [...opts.answers],
  };
}
