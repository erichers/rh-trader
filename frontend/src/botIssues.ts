/** Red issues block a bot. Amber and blue notes do not. */

function readJson(v: unknown, d: any): any {
  if (v == null) return d;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return d; }
}

export type BotIssue = { msg: string; cta?: string; href?: string; kind: string };

export function botIssues(bot: any, health: any): BotIssue[] {
  const out: BotIssue[] = [];
  const on = !!bot?.enabled;
  const lr = readJson(bot?.last_result, null);
  if (on) {
    const errs = Array.isArray(lr) ? lr.filter((r: any) => r?.error || r?.skipped) : [];
    for (const e of errs) out.push({ kind: 'red', msg: `${e.symbol || ''}: ${e.error || e.skipped}` });
  }

  if (bot?.asset_class === 'equity' || bot?.asset_class === 'etf') {
    out.push({ kind: 'red', msg: 'Equity bot — options-only desk will DELETE this row (not convert/park).' });
  }
  if (bot?.asset_class === 'option' && health && !health.broker?.alpacaConfigured) {
    out.push({ kind: 'amber', msg: 'Options need market data — Alpaca not configured.', cta: 'Open Settings', href: '#/settings' });
  }
  if (bot?.enabled && health?.env === 'robinhood_live' && health?.rh?.status !== 'connected') {
    out.push({ kind: 'amber', msg: 'Live env selected and the broker is not set up.', cta: 'Open Settings', href: '#/settings' });
  }
  if (readJson(bot?.action, {})._observe_only || readJson(bot?.rules, {})._observe_only || /Mean-Revert Watch|Quiet Range Scout|Vol-Regime MR/i.test(bot?.name || '')) {
    out.push({ kind: 'blue', msg: 'Watch stub — even while ON it cannot place, stage, or draft an order.' });
  }
  if (readJson(bot?.action, {})._quickbot) return out;
  const rules = readJson(bot?.rules, {});
  if (!Object.keys(rules).filter((k) => k !== 'require_all' && k !== 'min_matches').length) {
    out.push({ kind: 'red', msg: 'No trigger rules — bot cannot fire.', cta: 'Edit rules' });
  }
  return out;
}

export function isBlockedBot(bot: any, health: any): boolean {
  return botIssues(bot, health).some((p) => p.kind === 'red');
}

export function blockedBotCount(bots: any[] | null | undefined, health: any): number {
  return (bots || []).filter((b) => isBlockedBot(b, health)).length;
}
