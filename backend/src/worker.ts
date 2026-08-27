import { rh } from './rh/mcpClient.js';
import { syncAll } from './brokers/index.js';
import { brokerKind } from './brokers/index.js';
import { alpacaConfigured } from './brokers/alpaca.js';
import { evaluateAllEnabledBots } from './bots/engine.js';
import { audit, getKillSwitch, getTradingEnv } from './db.js';
import { isMarketOpen } from './market/clock.js';
import { refreshNews } from './market/news.js';
import { checkMonitors } from './risk/monitor.js';
import { getActiveCampaign, recordSnapshot, activateArmedIfFunded } from './campaign.js';
import { dailyReview, newsMonitor } from './ai/advisor.js';
import { getFocus, learnTicker } from './focus.js';
import { runAlertEngine } from './alerts.js';
import { probeProviders } from './ai/models.js';
import { recordEquitySnapshot } from './market/pnl.js';
import { ensureFleet } from './fleet.js';
import { embedPending } from './rag.js';
import { learningTick } from './learning.js';

let timers: NodeJS.Timeout[] = [];

async function brokerReady(): Promise<boolean> {
  const env = await getTradingEnv();
  return brokerKind(env) === 'alpaca' ? alpacaConfigured() : rh.isConnected();
}

/** Self-scheduling loop with a re-entrancy guard: a slow tick can NEVER overlap the
 *  next one (which would double-fire orders / double-spend AI tokens). The next run
 *  is scheduled only after the current finishes. */
function loop(label: string, everyMs: number, body: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return; // previous tick still in flight — skip this one
    running = true;
    try { await body(); }
    catch (e: any) { await audit(`worker.${label}.error`, e?.message || String(e)); }
    finally { running = false; }
  }, everyMs);
}

/** Background loops: sync the active broker + evaluate enabled bots. */
export function startWorker() {
  const sync = loop('sync', 30_000, async () => {
    const env = await getTradingEnv();
    if (brokerKind(env) === 'robinhood' && !rh.isConnected()) await rh.connect();
    if (await brokerReady()) {
      await syncAll();
      // Record today's equity for THIS account (idempotent per day) — the P/L history
      // for brokers that expose no equity-history API.
      await recordEquitySnapshot(env).catch(() => {});
    }
    // Safety net: an account with no bots at all gets its fresh (disabled) fleet seeded
    // once, even if it was switched to outside the /api/env route.
    await ensureFleet(env).catch(() => {});
    // Armed campaign → goes LIVE the moment a real Robinhood deposit shows up (cheap check).
    await activateArmedIfFunded().catch(() => {});
  });

  const bots = loop('bots', 120_000, async () => {
    if (await getKillSwitch()) return;
    // Only fire bots while the US equity market is open (holiday-aware via Alpaca).
    if (!(await isMarketOpen())) return;
    await evaluateAllEnabledBots();
  });

  // Live trailing-stop / TP / SL enforcement on open positions (every 45s, market hours).
  // NOTE: do NOT skip on the kill switch — exits are close-only protection and must keep
  // running while the switch is engaged (the switch blocks new BUYS, not protective SELLS).
  const monitors = loop('monitor', 45_000, async () => {
    // Off-hours: reconcile dead monitors (expired contracts) so the alerts loop — which
    // runs 24/7 — can't keep firing false criticals from them; exits wait for the session.
    if (!(await isMarketOpen())) { await checkMonitors({ reconcileOnly: true }); return; }
    await checkMonitors();
  });

  // Operational alerts: order fills, stop/TP exits, FAILED exits, intraday drawdown breaches.
  // Runs even off-hours so an after-hours failed-exit or a drawdown is still surfaced. Cheap
  // (cursor-driven, mostly indexed reads) and de-duplicated inside the engine.
  const alerts = loop('alerts', 60_000, async () => { await runAlertEngine(); });

  // Refresh real market news every 10 minutes.
  const news = loop('news', 600_000, async () => { await refreshNews(); });

  // Record the daily campaign tracking snapshot (equity vs target curve + coaching).
  const campaign = loop('campaign', 3_600_000, async () => { if (await getActiveCampaign()) await recordSnapshot(); });

  // Passive news triage → escalates flagged items to the research chain (every ~2h, cheap).
  const newsAi = loop('newsAi', 2 * 3_600_000, async () => { await newsMonitor(); });

  // Daily (24h) strategy/trend review → coaching + highlight alerts.
  const review = loop('review', 24 * 3_600_000, async () => { await dailyReview(); });

  // FOCUS learning loop: while focus mode is on, the system continuously scores +
  // learns the focus ticker (triage chain, cheap; escalates to research on material reads).
  const focusLearn = loop('focus', 40 * 60_000, async () => {
    const f = await getFocus();
    // Only auto-learn during market hours (avoids overnight/weekend token burn +
    // duplicate low-information insights). Manual "Learn now" works anytime.
    if (f.enabled && (await isMarketOpen())) await learnTicker(f.symbol);
  });

  // Embed new learnings/RAG documents in small batches (no-op while NVIDIA_API_KEY is
  // unset: the corpus keeps working on FULLTEXT alone).
  const embed = loop('embed', 600_000, async () => { await embedPending({ limit: 64 }); });

  // Learning iterator: checks every 10 minutes, runs at most one pass per account per day
  // (daily after the US close on a session day, weekly digest on Sunday).
  const learning = loop('learning', 600_000, async () => { await learningTick(); });

  // Re-verify every provider's live model ids (model ids get retired without notice).
  const models = loop('models', 6 * 3_600_000, async () => { await probeProviders(); });

  timers = [sync, bots, news, monitors, campaign, newsAi, review, focusLearn, alerts, models, embed, learning];
  void (async () => {
    await probeProviders().catch(() => {}); // non-blocking at boot, before the first AI call
    if (await brokerReady()) await syncAll().catch(() => {});
    await refreshNews().catch(() => {});
    if (await getActiveCampaign()) await recordSnapshot().catch(() => {});
    // Kick the advisor + a first focus read shortly after boot.
    setTimeout(() => {
      dailyReview().catch(() => {});
      newsMonitor().catch(() => {});
      getFocus().then((f) => { if (f.enabled) learnTicker(f.symbol).catch(() => {}); }).catch(() => {});
    }, 20_000);
  })();
}

export function stopWorker() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
