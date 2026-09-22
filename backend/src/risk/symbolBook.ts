/**
 * Same-symbol book already open: position, today's fills, staged/placed, and
 * in-process reservations. Shared by the risk gate and the pre-draft fitter
 * so those two numbers cannot drift.
 */

import { q } from '../db.js';
import {
  openSymbolExposureUsd,
  reservedBuyNotional,
  splitInflightBuys,
  todayEt,
  type ExposureOrder,
} from './exposure.js';

export type SymbolBook = {
  openUsd: number;
  pendingUsd: number;
  reservedUsd: number;
  todayFilledUsd: number;
  positionMv: number;
};

export async function loadSymbolBook(env: string, symbol: string): Promise<SymbolBook> {
  const [pos] = await q<{ mv: number }>(
    'SELECT COALESCE(market_value,0) mv FROM positions WHERE symbol=:s AND env=:env ORDER BY updated_at DESC LIMIT 1',
    { s: symbol, env },
  );
  const inflight = await q<ExposureOrder>(
    `SELECT qty, filled_price, limit_price, asset_class, status, raw, created_at
     FROM orders WHERE symbol=:s AND env=:env AND side='buy'
       AND status IN ('placed','filled','staged')`,
    { s: symbol, env },
  );
  const { pendingUsd, todayFilledUsd } = splitInflightBuys(inflight, todayEt());
  const reservedUsd = reservedBuyNotional(env, symbol);
  const positionMv = Number(pos?.mv ?? 0);
  return {
    positionMv,
    pendingUsd,
    todayFilledUsd,
    reservedUsd,
    openUsd: openSymbolExposureUsd({ positionMv, todayFilledUsd, pendingUsd, reservedUsd }),
  };
}
