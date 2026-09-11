import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ping, getGlobalMode, getKillSwitch, audit, migrate } from './db.js';
import { rh } from './rh/mcpClient.js';
import { startAuthCallbackServer } from './rh/authServer.js';
import { registerRoutes } from './routes/api.js';
import { startWorker, stopWorker } from './worker.js';
import { aiReady } from './ai/claude.js';
import { hardenObserveOnlyBots } from './bots/strategies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
function logFatal(kind: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[fatal] ${kind} ${new Date().toISOString()} ${msg}`);
}

async function main() {
  await migrate().catch((e) => console.error('migrate failed (non-fatal):', e?.message || e));
  await hardenObserveOnlyBots().catch((e) => console.error('observe-only harden (non-fatal):', e?.message || e));
  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 5 * 1024 * 1024 });

  // Tolerate empty-body application/json POSTs (many buttons send no body) →
  // parse as {} instead of failing with FST_ERR_CTP_EMPTY_JSON_BODY (400).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { done(e as Error, undefined); }
  });

  await app.register(fastifyWebsocket);
  await registerRoutes(app);

  // Live status websocket. ONE shared 5s timer computes status (3 DB reads) once and
  // broadcasts to all sockets — not a per-connection timer (which multiplied DB load
  // by the number of open tabs and could starve the pool).
  const sockets = new Set<any>();
  let lastStatus = '{}';
  const refreshStatus = async () => {
    try {
      lastStatus = JSON.stringify({
        type: 'status', rh: rh.status, mode: await getGlobalMode(),
        killSwitch: await getKillSwitch(), db: await ping(), ai: aiReady(), ts: Date.now(),
      });
    } catch { /* keep prior */ }
    for (const s of sockets) { try { s.send(lastStatus); } catch { sockets.delete(s); } }
  };
  setInterval(refreshStatus, 5000);
  void refreshStatus();
  app.register(async (w) => {
    w.get('/ws', { websocket: true }, (socket) => {
      sockets.add(socket);
      try { socket.send(lastStatus); } catch { /* noop */ }
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
  });

  // Static SPA (built frontend). Falls back to index.html for client routing.
  if (fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, { root: frontendDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  } else {
    app.get('/', async () => ({
      app: 'rh.tradingbot backend',
      note: 'frontend not built yet — run `npm run build` in /frontend',
      health: '/api/health',
    }));
  }

  // Catch the Robinhood OAuth redirect so in-app "Connect" completes the flow.
  startAuthCallbackServer();

  // Try connecting to Robinhood (non-fatal if needs auth).
  rh.connect()
    .then((s) => app.log.info(`[robinhood] status: ${s}`))
    .catch(() => {});

  const host = '127.0.0.1';
  const port = config.server.port;
  try {
    await app.listen({ port, host });
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      console.error(`[boot] ${host}:${port} is already in use. Stop the old process (./scripts/stop.sh) or change PORT.`);
    }
    throw e;
  }
  app.log.info(`rh.tradingbot backend on http://${host}:${port}`);
  app.log.info(`health: http://${host}:${port}/api/health`);
  app.log.info(`via MAMP (optional): http://localhost:8888${config.server.basePath}/`);
  await audit('boot', 'backend started', { port, ai: aiReady(), paper: true });

  startWorker();

  const shutdown = async (signal: string) => {
    app.log.info(`[boot] ${signal} — stopping worker and closing listen socket`);
    stopWorker();
    try { await app.close(); } catch { /* already closing */ }
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => logFatal('unhandledRejection', err));

main().catch((e) => {
  logFatal('main', e);
  process.exit(1);
});
