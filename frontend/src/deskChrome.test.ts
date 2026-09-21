import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_STALE_MS,
  KILL_ENGAGE_CONFIRM,
  PAPER_NEXT_STEP,
  PAPER_POSITIONS_EMPTY,
  deleteBotConfirm,
  jevChipStale,
  killEngageNeedsConfirm,
  promoteLiveOpen,
} from './deskChrome.ts';
import { museLamp } from './museLamp.ts';
import { bookPeakPct, bookPlPct, bookSizeUsd, humanOcc, parseOcc } from './optionBook.ts';

describe('paper desk chrome', () => {
  it('keeps Muse idle off green and says improve · idle', () => {
    const idle = museLamp({ mode: 'improve', running: false, lastCycle: '2026-09-21T12:00:00Z' });
    assert.equal(idle.text, 'improve · idle');
    assert.equal(idle.kind, 'gray');
    assert.notEqual(idle.dot, 'green');
    const waiting = museLamp({ mode: 'improve', running: false });
    assert.equal(waiting.kind, 'gray');
    assert.equal(waiting.text, 'improve · waiting');
    const running = museLamp({ mode: 'improve', running: true, lastCycle: '2026-09-21T12:00:00Z' });
    assert.equal(running.kind, 'green');
    assert.equal(running.text, 'improve · running');
  });

  it('uses the paper empty lines and never tells you to connect Robinhood', () => {
    assert.equal(PAPER_POSITIONS_EMPTY, 'No open paper positions.');
    assert.equal(PAPER_NEXT_STEP, 'Enable a bot or Sync Alpaca.');
    assert.equal(`${PAPER_POSITIONS_EMPTY} ${PAPER_NEXT_STEP}`.includes('Connect Robinhood'), false);
  });

  it('confirms kill engage and releases in one click', () => {
    assert.equal(killEngageNeedsConfirm(false), true);
    assert.equal(killEngageNeedsConfirm(true), false);
    assert.match(KILL_ENGAGE_CONFIRM, /Engage the kill switch/);
  });

  it('confirms bot delete with the name and no undo', () => {
    assert.equal(deleteBotConfirm('SPY calls'), 'Delete bot SPY calls? This cannot undo.');
  });

  it('closes promote-to-live on paper and marks a Jev chip stale after 4 hours', () => {
    assert.equal(promoteLiveOpen('alpaca_paper', false), false);
    assert.equal(promoteLiveOpen('robinhood_live', true), true);
    const now = Date.parse('2026-09-21T16:00:00Z');
    assert.equal(jevChipStale('2026-09-21T12:00:00Z', now), false);
    assert.equal(jevChipStale(new Date(now - JEV_STALE_MS).toISOString(), now), false);
    assert.equal(jevChipStale(new Date(now - JEV_STALE_MS - 1).toISOString(), now), true);
    assert.equal(jevChipStale(null, now), false);
  });

  it('reads a human OCC, P/L %, peak %, and size with the ×100 multiplier', () => {
    const occ = parseOcc('SPY260930C00500000');
    assert.equal(occ?.root, 'SPY');
    assert.equal(humanOcc('SPY260930C00500000'), 'September 30, 2026, $500 Call');
    assert.equal(bookPlPct(100, 110), 10);
    assert.equal(bookPeakPct(100, 130), 30);
    assert.equal(bookSizeUsd(3, 2.5, 'option', 'SPY260930C00500000'), 750);
    assert.equal(bookSizeUsd(3, 2.5, 'equity'), 7.5);
  });
});