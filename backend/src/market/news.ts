import { exec, q } from '../db.js';
import { alpacaPaper, alpacaConfigured } from '../brokers/alpaca.js';

/**
 * Fetch REAL market news from Alpaca and store it. No fabricated/sample data —
 * if Alpaca isn't configured this returns 0 and stores nothing.
 */
export async function refreshNews(symbols?: string[], limit = 50): Promise<{ fetched: number; stored: number }> {
  if (!alpacaConfigured()) return { fetched: 0, stored: 0 };
  let watch = symbols;
  if (!watch || !watch.length) {
    const rows = await q<{ symbol: string }>('SELECT symbol FROM watchlist');
    watch = rows.map((r) => r.symbol);
  }
  const items = await alpacaPaper.news(watch, limit).catch(() => [] as any[]);
  let stored = 0;
  for (const it of items) {
    const extId = String(it.id ?? '');
    const sym = Array.isArray(it.symbols) && it.symbols.length ? it.symbols[0] : null;
    const res = await exec(
      `INSERT INTO news (ext_id, symbol, headline, summary, source, url, published_at, raw)
       VALUES (:ext,:sym,:h,:s,:src,:url,:pub,CAST(:raw AS JSON))
       ON DUPLICATE KEY UPDATE headline=:h, summary=:s`,
      {
        ext: extId,
        sym,
        h: it.headline ?? '',
        s: it.summary ?? '',
        src: it.source ?? 'Alpaca',
        url: it.url ?? null,
        pub: it.created_at ? new Date(it.created_at).toISOString().slice(0, 19).replace('T', ' ') : null,
        raw: JSON.stringify({ symbols: it.symbols, author: it.author, updated_at: it.updated_at }),
      },
    );
    if (res.affectedRows > 0) stored++;
  }
  return { fetched: items.length, stored };
}
