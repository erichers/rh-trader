/**
 * Muse auditor — reviews a fired-bot decision packet. Never submits orders.
 * May recommend `soft_block` for Jev/code to honor only in active mode.
 */

import { audit } from '../db.js';
import { choice, decideGo, score, FAIL, PASS, UNKNOWN, type Decision } from '../risk/decide.js';

export type MuseAuditFlag = 'ok' | 'soft_block' | 'note';

export type MuseDecisionPacket = {
  symbol?: string | null;
  bot?: string | null;
  why?: string | null;
  checks?: Record<string, { pass?: boolean; detail?: string } | string> | null;
  riskOk?: boolean | null;
  jevPick?: string | null;
  jevFailOpen?: boolean | null;
  side?: string | null;
  source?: string | null;
};

export type MuseAudit = {
  flag: MuseAuditFlag;
  because: string;
  submitted: false;
  decision: Decision;
};

function checkPass(checks: MuseDecisionPacket['checks'], key: string): boolean | null {
  const raw = checks?.[key];
  if (raw == null) return null;
  if (typeof raw === 'string') return !/block|fail|veto/i.test(raw);
  if (typeof raw === 'object' && 'pass' in raw) return raw.pass !== false;
  return null;
}

/** Local TypeSafe-style review. No network. Muse never places. */
export function museAuditLocal(packet: MuseDecisionPacket): MuseAudit {
  const why = String(packet.why || '');
  const stale = /already >|no fresh|stale|already positive|no upward cross/i.test(why);
  const hardFail =
    packet.riskOk === false
    || checkPass(packet.checks, 'kill_switch') === false
    || checkPass(packet.checks, 'entry_dte') === false
    || checkPass(packet.checks, 'puts_blocked') === false
    || checkPass(packet.checks, 'calls_only') === false;

  const rails = choice({
    id: 'rails_already_enforced',
    options: [PASS, FAIL, UNKNOWN] as const,
    pick: hardFail ? FAIL : PASS,
    because: hardFail ? 'hard rails failed — auditor does not resubmit' : 'hard rails already decided',
  });
  const freshness = choice({
    id: 'signal_fresh',
    options: [PASS, FAIL, UNKNOWN] as const,
    pick: stale ? FAIL : (why ? PASS : UNKNOWN),
    because: stale ? 'why looks stale / leftover state' : (why ? 'why present' : 'no why'),
  });
  const quality = score({
    id: 'packet_quality',
    levels: ['thin', 'ok', 'rich'],
    value: why && packet.checks ? 2 : why ? 1 : 0,
    because: 'decision packet completeness',
  });
  const go = decideGo({
    answers: [rails, freshness, quality],
    goWhen: { rails_already_enforced: PASS, signal_fresh: PASS },
    scoreFloors: { packet_quality: 1 },
  });

  let flag: MuseAuditFlag = 'ok';
  let because = go.because;
  if (hardFail) {
    flag = 'note';
    because = 'hard rails already vetoed — Muse will not place';
  } else if (stale || !go.go) {
    flag = 'soft_block';
    because = stale ? 'soft_block — stale/contradictory signal (recommendation only)' : `soft_block — ${go.because}`;
  } else if (packet.jevPick === 'skip' && packet.jevFailOpen) {
    flag = 'note';
    because = 'Jev skip was fail-open/shadow — Muse notes, does not place';
  }

  return { flag, because, submitted: false, decision: go };
}

export async function museAuditAfterFire(
  packet: MuseDecisionPacket,
  deps: { log?: typeof audit } = {},
): Promise<MuseAudit> {
  const row = museAuditLocal(packet);
  const write = deps.log || audit;
  await write('muse.audit', `${packet.symbol || '?'} ${row.flag} — ${row.because}`.slice(0, 240), {
    symbol: packet.symbol ?? null,
    bot: packet.bot ?? null,
    flag: row.flag,
    submitted: false,
    jev: packet.jevPick ?? null,
    why: String(packet.why || '').slice(0, 200),
  }).catch(() => {});
  return row;
}
