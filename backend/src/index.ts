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
import { startWorker } from './worker.js';
import { aiReady } from './ai/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

async function main() {
  await migrate().catch((e) => console.error('migrate failed (non-fatal):', e?.message || e));
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

  await app.listen({ port: config.server.port, host: '127.0.0.1' });
  app.log.info(`rh.tradingbot backend on http://127.0.0.1:${config.server.port}`);
  app.log.info(`via MAMP: http://localhost:8888${config.server.basePath}/`);
  await audit('boot', 'backend started', { port: config.server.port, ai: aiReady() });

  startWorker();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
