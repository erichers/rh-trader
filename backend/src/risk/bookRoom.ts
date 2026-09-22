/**
 * Pre-draft book fit for bot and AI buys.
 * Skip or size down before executeDraft inserts a veto row when the
 * same-symbol book (bot cap, else the desk $10k) cannot hold another ticket.
 */

import { getRiskLimits, q } from '../db.js';
import { resolveCaps, type OrderDraft } from './engine.js';
import { clampRiskLawPositionUsd, RISK_LAW } from './law.js';
import { fitBuyToSymbolBook, type BookFit } from './exposure.js';
import { loadSymbolBook } from './symbolBook.js';

function parse(v: unknown): any {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

/** Null when this draft is not a bot/AI buy. Otherwise a pass, size-down, or skip. */
export async function fitDraftToSymbolBook(draft: OrderDraft, env: string): Promise<BookFit | null> {
  if (draft.side !== 'buy') return null;
  if (draft.source !== 'bot' && draft.source !== 'ai') return null;

  let botRisk: any = null;
  if (draft.bot_id) {
    const [bot] = await q<{ risk: any }>('SELECT risk FROM bots WHERE id=:id AND env=:env', { id: draft.bot_id, env });
    botRisk = bot?.risk ? parse(bot.risk) : null;
  }
  const lim = await getRiskLimits();
  const caps = resolveCaps(botRisk, draft._play, lim);
  const maxPositionUsd = clampRiskLawPositionUsd(caps.maxPositionUsd, RISK_LAW.maxTradeUsd);
  const book = await loadSymbolBook(env, draft.symbol);
  const [acct] = await q<{ equity: number }>(
    'SELECT equity FROM accounts WHERE env=:env ORDER BY updated_at DESC LIMIT 1',
    { env },
  );
  const ac = String(draft.asset_class || 'equity').toLowerCase();
  const px = Number(draft.est_price ?? draft.limit_price) || 0;
  const unit = px > 0 ? px * (ac === 'option' ? 100 : 1) : 0;
  return fitBuyToSymbolBook({
    qty: Number(draft.qty) || 1,
    unitCost: unit,
    openUsd: book.openUsd,
    maxPositionUsd,
    maxConcentrationPct: caps.maxConcentrationPct,
    equity: Number(acct?.equity ?? 0),
  });
}
