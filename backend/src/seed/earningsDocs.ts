/**
 * Earnings decks & transcripts library. Stores the REAL investor-relations
 * archive URL for each favorite (where all quarterly decks/transcripts live),
 * plus analyzed summaries for the recent quarters verified via web fetch.
 * No fabricated figures — un-fetched quarters are linked, not invented.
 *   npm run seed:earnings-docs
 */
import { exec, pool } from '../db.js';

type Doc = {
  symbol: string; period: string; type: 'archive' | 'deck' | 'transcript' | 'press';
  title: string; url: string; analyzed?: boolean; summary?: string; key_points?: string[]; source?: string;
};

// Canonical IR archives (all 8+ quarters of decks/transcripts live here).
const ARCHIVES: Doc[] = [
  { symbol: 'TSLA', period: 'ALL', type: 'archive', title: 'Tesla IR — Quarterly Disclosures (all decks)', url: 'https://ir.tesla.com/#quarterly-disclosure', source: 'Tesla IR' },
  { symbol: 'META', period: 'ALL', type: 'archive', title: 'Meta Investor Relations — Financials & events', url: 'https://investor.atmeta.com/', source: 'Meta IR' },
  { symbol: 'MSFT', period: 'ALL', type: 'archive', title: 'Microsoft Investor Relations — Earnings', url: 'https://www.microsoft.com/en-us/investor/earnings/', source: 'Microsoft IR' },
  { symbol: 'AMD', period: 'ALL', type: 'archive', title: 'AMD IR — Quarterly Results', url: 'https://ir.amd.com/financial-information/quarterly-results', source: 'AMD IR' },
  { symbol: 'NVDA', period: 'ALL', type: 'archive', title: 'NVIDIA IR — Quarterly Results', url: 'https://investor.nvidia.com/financial-info/quarterly-results/', source: 'NVIDIA IR' },
  // Transcript hubs (free full transcripts).
  { symbol: 'TSLA', period: 'TRANSCRIPTS', type: 'transcript', title: 'Tesla earnings call transcripts (Motley Fool)', url: 'https://www.fool.com/quote/nasdaq/tsla/', source: 'Motley Fool' },
  { symbol: 'MSFT', period: 'TRANSCRIPTS', type: 'transcript', title: 'Microsoft earnings call transcripts (Yahoo/Fool)', url: 'https://finance.yahoo.com/quote/MSFT/', source: 'Yahoo Finance' },
  { symbol: 'META', period: 'TRANSCRIPTS', type: 'transcript', title: 'Meta earnings call transcripts (Motley Fool)', url: 'https://www.fool.com/quote/nasdaq/meta/', source: 'Motley Fool' },
  { symbol: 'AMD', period: 'TRANSCRIPTS', type: 'transcript', title: 'AMD earnings call transcripts (Motley Fool)', url: 'https://www.fool.com/quote/nasdaq/amd/', source: 'Motley Fool' },
  { symbol: 'NVDA', period: 'TRANSCRIPTS', type: 'transcript', title: 'NVIDIA earnings call transcripts (Motley Fool)', url: 'https://www.fool.com/quote/nasdaq/nvda/', source: 'Motley Fool' },
];

// Analyzed recent quarters (figures verified via web fetch / reporting).
const ANALYZED: Doc[] = [
  {
    symbol: 'MSFT', period: 'FY26 Q3', type: 'press', analyzed: true,
    title: 'Microsoft FY26 Q3 (qtr ended Mar 31, 2026)',
    url: 'https://www.microsoft.com/en-us/investor/earnings/fy-2026-q3/',
    summary: 'Broad beat led by cloud/AI. Revenue $82.9B (+18% YoY, +15% cc); net income $31.8B (+23%); diluted EPS $4.27 (+23%). Intelligent Cloud $34.7B (+30%), Azure +40%. AI run-rate surpassed $37B (+123% YoY). Capex elevated (9-mo $80.1B vs $47.5B prior).',
    key_points: ['Rev $82.9B (+18%)', 'EPS $4.27 (+23%)', 'Azure +40%', 'AI run-rate $37B (+123%)', 'Intelligent Cloud $34.7B (+30%)', 'MPC $13.2B (-1%)', '9-mo capex $80.1B'],
    source: 'Microsoft IR',
  },
  {
    symbol: 'TSLA', period: 'Q1 2026', type: 'deck', analyzed: true,
    title: 'Tesla Q1 2026 Shareholder Update (reported Apr 22, 2026)',
    url: 'https://ir.tesla.com/#quarterly-disclosure',
    summary: 'Slight miss. Adjusted EPS $0.41 vs $0.37 est; revenue $22.39B vs $22.64B est; deliveries light. Robotaxi the bull case: paid robotaxi miles ~doubled QoQ; unsupervised service live in Austin, Dallas, Houston. Cybercab/Semi/Megapack 3 volume targeted for 2026.',
    key_points: ['Adj EPS $0.41 (est $0.37)', 'Revenue $22.39B (est $22.64B)', 'Deliveries light', 'Robotaxi paid miles ~2x QoQ', 'Unsupervised FSD: Austin/Dallas/Houston'],
    source: 'CNBC / Tesla IR',
  },
  {
    symbol: 'META', period: 'Q1 2026', type: 'press', analyzed: true,
    title: 'Meta Q1 2026 (reported Apr 29, 2026)',
    url: 'https://investor.atmeta.com/',
    summary: 'Strong beat with raised AI spend. Revenue $56.31B (+33% YoY) vs $55.45B est; ex-tax EPS ~$7.31 vs $6.79 est. 2026 capex outlook raised to $125–145B (from $115–135B). Q2 revenue guided $58–61B.',
    key_points: ['Revenue $56.31B (+33%)', 'EPS ~$7.31 ex-tax (beat $6.79)', '2026 capex $125–145B (raised)', 'Q2 guide $58–61B'],
    source: 'Quartz / CNBC',
  },
];

async function main() {
  for (const d of [...ARCHIVES, ...ANALYZED]) {
    await exec(
      `INSERT INTO earnings_docs (symbol, period_label, doc_type, title, url, analyzed, summary, key_points, source)
       VALUES (:s,:p,:t,:title,:url,:an,:sum,CAST(:kp AS JSON),:src)
       ON DUPLICATE KEY UPDATE title=:title,url=:url,analyzed=:an,summary=:sum,key_points=CAST(:kp AS JSON),source=:src`,
      { s: d.symbol, p: d.period, t: d.type, title: d.title, url: d.url, an: d.analyzed ? 1 : 0,
        sum: d.summary ?? null, kp: JSON.stringify(d.key_points ?? []), src: d.source ?? null },
    );
    console.log(d.symbol, d.period, d.type, d.analyzed ? '(analyzed)' : '');
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
