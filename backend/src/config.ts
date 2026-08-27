import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..'); // backend/
const projectRoot = path.resolve(root, '..'); // repo root
// Load repo-root .env (preferred), then backend/.env as a fallback.
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(root, '.env') });

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export type Mode = 'observe' | 'cautious' | 'auto' | 'full_auto';
export const MODES: Mode[] = ['observe', 'cautious', 'auto', 'full_auto'];

// Trading environment = which broker/account orders route to.
//  alpaca_paper  → Alpaca paper account (fake money, real data) — for testing
//  alpaca_live   → Alpaca live account (REAL money)
//  robinhood_live→ Robinhood agentic account (REAL money)
// Only two environments: Alpaca paper (testing) and Robinhood live (real money).
export type TradingEnv = 'alpaca_paper' | 'robinhood_live';
export const TRADING_ENVS: TradingEnv[] = ['alpaca_paper', 'robinhood_live'];
export function isLiveEnv(env: TradingEnv): boolean {
  return env !== 'alpaca_paper';
}

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    effort: (process.env.ANTHROPIC_EFFORT || 'high') as
      | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  },
  kimi: {
    apiKey: process.env.KIMI_API_KEY || '',
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    // Model ids live in ai/models.ts; KIMI_MODEL overrides that provider's default pick.
    model: process.env.KIMI_MODEL || '',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    // Model ids live in ai/models.ts; GROQ_MODEL overrides that provider's default pick.
    model: process.env.GROQ_MODEL || '',
  },
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY || '',
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: process.env.NVIDIA_MODEL || '',
  },
  // Any OpenAI-compatible server you run yourself (Ollama: http://localhost:11434/v1,
  // LM Studio: http://localhost:1234/v1, vLLM, llama.cpp). Key optional. Last rung of every chain.
  local: {
    apiKey: process.env.LOCAL_API_KEY || '',
    baseUrl: process.env.LOCAL_BASE_URL || '',
    model: process.env.LOCAL_MODEL || '',
  },
  rh: {
    mcpUrl: process.env.RH_MCP_URL || 'https://agent.robinhood.com/mcp/trading',
    tokenStore: path.resolve(
      root,
      process.env.RH_TOKEN_STORE
        ? process.env.RH_TOKEN_STORE.replace(/^\.\/backend\//, './')
        : './data/oauth-tokens.json',
    ),
    callbackPort: num(process.env.RH_OAUTH_CALLBACK_PORT, 7321),
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 8889),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? 'root',
    database: process.env.DB_NAME || 'rh_tradingbot',
  },
  server: {
    port: num(process.env.PORT, 8011),
    basePath: process.env.BASE_PATH || '/rh.tradingbot',
  },
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY || '',
    secretKey: process.env.ALPACA_SECRET_KEY || '',
    paperBaseUrl: process.env.ALPACA_PAPER_BASE_URL || 'https://paper-api.alpaca.markets/v2',
    liveBaseUrl: process.env.ALPACA_LIVE_BASE_URL || 'https://api.alpaca.markets/v2',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets/v2',
  },
  trading: {
    defaultEnv: (process.env.TRADING_ENV || 'alpaca_paper') as TradingEnv,
    defaultMode: (process.env.DEFAULT_MODE || 'observe') as Mode,
    killSwitch: (process.env.KILL_SWITCH || 'false') === 'true',
    allowedAssetClasses: (process.env.ALLOWED_ASSET_CLASSES || 'equity,etf,option')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxPositionUsd: num(process.env.MAX_POSITION_USD, 2000),
    maxConcentrationPct: num(process.env.MAX_PORTFOLIO_CONCENTRATION_PCT, 25),
    maxDailyLossPct: num(process.env.MAX_DAILY_LOSS_PCT, 3),
    maxOrdersPerDay: num(process.env.MAX_ORDERS_PER_DAY, 40),
  },
  root,
};

// Asset classes that are NEVER tradable, no matter the mode or config.
export const HARD_BLOCKED_ASSET_CLASSES = ['crypto', 'cryptocurrency', 'coin'];

export function isCryptoSymbol(symbol: string): boolean {
  const s = (symbol || '').toUpperCase();
  // Common crypto tickers / pair notations Robinhood exposes.
  const known = new Set([
    'BTC', 'ETH', 'DOGE', 'SHIB', 'ADA', 'SOL', 'AVAX', 'MATIC', 'LTC', 'BCH',
    'XRP', 'XLM', 'ETC', 'UNI', 'AAVE', 'LINK', 'COMP', 'XTZ', 'DOT', 'PEPE',
    'USDC', 'USDT', 'BTC-USD', 'ETH-USD',
  ]);
  if (known.has(s)) return true;
  if (s.includes('-USD') || s.endsWith('USD') && s.length <= 7 && !s.includes('.')) {
    // pair-like notation (e.g. BTC-USD). Equities use plain tickers.
    if (s.includes('-USD')) return true;
  }
  return false;
}
