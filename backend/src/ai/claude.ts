import { pool, exec, getGlobalMode, getTradingEnv } from '../db.js';
import { rh, isOrderWriteTool } from '../rh/mcpClient.js';
import { executeDraft } from '../execute.js';
import type { OrderDraft } from '../risk/engine.js';
import { llmJSON, llmAgent, aiReady as _aiReady, aiProvider, aiLabel, aiShort, modelFor, type Tool } from './llm.js';

export function aiReady(): boolean { return _aiReady(); }
export { aiProvider, aiLabel, aiShort };

export const SYSTEM_RULES = `You are the trading brain for a private, local Robinhood/Alpaca automated-trading app.

NON-NEGOTIABLE RULES (violating these is a critical failure):
- ABSOLUTELY NO CRYPTOCURRENCY. Never propose, analyze for buying, or place any crypto order. Crypto is permanently banned and the risk engine will hard-veto it.
- LONG ONLY. Never short. A sell may only close an existing long position and never exceed the held quantity.
- Equities, ETFs, and long options only (calls = bullish, puts = bearish).
- You PROPOSE; deterministic code DISPOSES. Every order you propose passes through a risk engine (size, concentration, daily loss, throttle, kill switch) and the active execution mode. You cannot bypass it.
- Execution modes: observe (log only), cautious (staged for approval), auto (auto-execute within guardrails), full_auto (auto + may open new positions).
- Be concise, specific, quantitative. State conviction and key risks. Never fabricate prices/fills — use the tools/data.`;

// ── Structured research (provider-agnostic) ─────────────────────────────────
export async function analyzeSymbol(symbol: string, context?: string): Promise<any> {
  const user = `Analyze ${symbol} for a swing/position trade. ${context || ''}
Return a JSON object with exactly these keys:
  "thesis" (string, 2-3 sentences),
  "sentiment" (number -1..1),
  "conviction" (number 0..1),
  "regime" (string),
  "key_risks" (array of strings),
  "suggested_action" (one of "buy","hold","sell","avoid").
Long-only, no crypto.`;
  const parsed = await llmJSON(SYSTEM_RULES, user, 'research');
  await exec(
    `INSERT INTO research_analyses (symbol, thesis, sentiment, conviction, regime, key_risks, suggested_action, provider, model, raw)
     VALUES (:symbol,:thesis,:sentiment,:conviction,:regime,CAST(:key_risks AS JSON),:suggested_action,:provider,:model,CAST(:raw AS JSON))`,
    {
      symbol,
      thesis: parsed.thesis ?? parsed._raw ?? '',
      sentiment: clamp(parsed.sentiment, -1, 1),
      conviction: clamp(parsed.conviction, 0, 1),
      regime: parsed.regime ?? 'unknown',
      key_risks: JSON.stringify(parsed.key_risks ?? []),
      suggested_action: parsed.suggested_action ?? 'hold',
      // provenance of the model that actually answered (the chain may have cascaded)
      provider: parsed._provider ?? aiProvider() ?? 'none',
      model: parsed._model ?? modelFor('research') ?? '',
      raw: JSON.stringify(parsed),
    },
  );
  return parsed;
}

// ── Read-only SQL assistant ─────────────────────────────────────────────────
function safeSelect(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(s)) throw new Error('only SELECT allowed');
  if (s.includes(';')) throw new Error('multiple statements blocked');
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|replace)\b/i.test(s)) throw new Error('write keyword blocked');
  if (/\binto\s+(outfile|dumpfile)\b/i.test(s)) throw new Error('file write blocked');
  if (/\b(load_file|sys_exec|benchmark|sleep)\s*\(/i.test(s)) throw new Error('blocked function');
  return /\blimit\b/i.test(s) ? s : `${s} LIMIT 200`;
}

const SQL_TOOL: Tool = {
  name: 'run_sql',
  description:
    'Run a READ-ONLY SELECT against the local MySQL trading DB (tables: orders, positions, accounts, bots, signals, risk_events, research_analyses, news, learnings, playbooks, backtests, audit_log). Returns up to 200 rows as JSON.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { sql: { type: 'string', description: 'A single SELECT statement' } },
    required: ['sql'],
  },
};

const SEARCH_TOOL: Tool = {
  name: 'search_knowledge',
  description:
    'Full-text RAG search across the local knowledge base — news (headline + url), research notes, learnings, RAG docs, and per-ticker insights. Each hit may include title, snippet, symbol, and url. Use url only when present. Use this for "what do we know / what has the news said / what have we learned about X" questions. Optionally scope to a ticker symbol.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Search terms' },
      symbol: { type: 'string', description: 'Optional ticker to scope the search (e.g. NVDA)' },
    },
    required: ['query'],
  },
};

export async function assistantChat(message: string): Promise<{ answer: string; provider: string; model: string }> {
  await exec('INSERT INTO chat_messages (role, content) VALUES ("user", :c)', { c: message });
  const { searchKnowledge } = await import('../knowledge.js');
  const { text, provider, model } = await llmAgent(
    SYSTEM_RULES + `

You answer questions about the user's trading data and knowledge base. Use run_sql for structured data and search_knowledge for news, research notes, learnings, and RAG docs. Cite what you find.

FORMAT (the UI renders Markdown):
- Reply in clean Markdown: **bold** labels, short headings, and bullet or numbered lists.
- When a search_knowledge hit includes a url, cite it as [headline](https://...). Only use http(s) URLs that appeared in tool results. Never invent, guess, or complete a URL.
- If a hit has no url, cite the headline and source in plain text, or [news #id](#/news). Do not write raw "[news id:N]" when a real url exists.
- Tickers may stay as SPY / META / TSLA; the UI will link them.
- Be concise. Paper + Observe: you do not place orders.`,
    message,
    [SQL_TOOL, SEARCH_TOOL],
    async (name, args) => {
      if (name === 'run_sql') { const [rows] = await pool.query(safeSelect(String(args.sql))); return rows; }
      if (name === 'search_knowledge') {
        return searchKnowledge(String(args.query || ''), {
          symbol: args.symbol ? String(args.symbol) : undefined,
          limit: 20,
          preferRecent: true,
        });
      }
      return { error: 'unknown tool' };
    },
    'chat',
    6,
    { readOnlyTools: true }, // run_sql + search_knowledge are read-only: safe to re-run on cascade
  );
  await exec(
    'INSERT INTO chat_messages (role, content, meta) VALUES ("assistant", :c, CAST(:meta AS JSON))',
    { c: text, meta: JSON.stringify({ provider, model }) },
  );
  return { answer: text, provider, model };
}

// ── Agentic trade turn ──────────────────────────────────────────────────────
const PROPOSE_ORDER_TOOL: Tool = {
  name: 'propose_order',
  description:
    'Propose a LONG equity/ETF/option order. Routed through the deterministic risk engine + active mode (logged, staged, or executed). NEVER crypto. Sells only close existing longs.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      symbol: { type: 'string' }, asset_class: { type: 'string', enum: ['equity', 'etf', 'option'] },
      side: { type: 'string', enum: ['buy', 'sell'] }, qty: { type: 'number' },
      order_type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit'] },
      limit_price: { type: 'number' }, est_price: { type: 'number' },
      option_type: { type: 'string', enum: ['call', 'put'] }, rationale: { type: 'string' },
    },
    required: ['symbol', 'side', 'qty', 'rationale'],
  },
};

function rhReadTools(): Tool[] {
  if (!rh.isConnected()) return [];
  return rh.listToolsCached()
    .filter((t) => !isOrderWriteTool(t.name))
    .map((t) => ({
      name: 'rh__' + t.name,
      description: (t.description || t.name) + ' (Robinhood, read-only)',
      parameters: t.inputSchema || { type: 'object', additionalProperties: true, properties: {} },
    }));
}

export async function agentTradeTurn(userPrompt: string, opts: { allowOpenNew?: boolean } = {}): Promise<{ answer: string; actions: any[]; provider: string; model: string }> {
  const envAtStart = await getTradingEnv(); // drafts are pinned to the account the turn started on
  const mode = await getGlobalMode();
  const actions: any[] = [];
  const tools = [...rhReadTools(), PROPOSE_ORDER_TOOL];
  const { text, provider, model } = await llmAgent(
    SYSTEM_RULES + `\n\nCurrent execution mode: ${mode}. ${opts.allowOpenNew ? 'You may open new positions.' : 'Only manage/close existing positions unless explicitly asked.'}`,
    userPrompt,
    tools,
    async (name, args) => {
      if (name === 'propose_order') {
        const draft: OrderDraft = {
          env: envAtStart,
          symbol: args.symbol, asset_class: args.asset_class || 'equity', side: args.side,
          qty: args.qty, order_type: args.order_type || 'market', limit_price: args.limit_price,
          est_price: args.est_price, option_type: args.option_type, source: 'ai',
        };
        const r = await executeDraft(draft, { rationale: args.rationale });
        actions.push(r);
        return { action: r.action, status: r.status, reason: r.reason };
      }
      if (name.startsWith('rh__')) return rh.callTool(name.slice(4), args);
      return { error: 'unknown tool' };
    },
    'agent',
    8,
  );
  return { answer: text, actions, provider, model };
}

function clamp(n: any, lo: number, hi: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}
