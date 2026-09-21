import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_COLLAPSED_KEY, readSidebarCollapsed, writeSidebarCollapsed, type SidebarStorage } from './sidebarPref.ts';
import { showRobinhoodConnect } from './deskChrome.ts';

function memory(): SidebarStorage & { dump(): Map<string, string> } {
  const mem = new Map<string, string>();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k, v) => { mem.set(k, v); },
    dump: () => mem,
  };
}

describe('sidebar collapse preference', () => {
  it('defaults expanded and persists collapse across a reload', () => {
    const store = memory();
    assert.equal(readSidebarCollapsed(store), false);
    assert.equal(readSidebarCollapsed(null), false);
    writeSidebarCollapsed(store, true);
    assert.equal(store.dump().get(SIDEBAR_COLLAPSED_KEY), '1');
    assert.equal(readSidebarCollapsed(store), true);
    writeSidebarCollapsed(store, false);
    assert.equal(readSidebarCollapsed(store), false);
    assert.equal(store.dump().get(SIDEBAR_COLLAPSED_KEY), '0');
  });

  it('hides Connect Robinhood on Alpaca paper', () => {
    assert.equal(showRobinhoodConnect('alpaca_paper', false), false);
    assert.equal(showRobinhoodConnect('alpaca_paper'), false);
    assert.equal(showRobinhoodConnect(undefined, false), false);
    assert.equal(showRobinhoodConnect('robinhood_live', true), true);
    assert.equal(showRobinhoodConnect('robinhood_live'), true);
  });
});