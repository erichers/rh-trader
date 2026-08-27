import http from 'node:http';
import { config } from '../config.js';
import { rh } from './mcpClient.js';
import { audit } from '../db.js';

let server: http.Server | null = null;

/** Idempotently run the OAuth redirect catcher on the callback port. */
export function startAuthCallbackServer(): void {
  if (server) return;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${config.rh.callbackPort}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('not found');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const html = (title: string, msg: string, ok: boolean) =>
      `<!doctype html><html><body style="font-family:system-ui;background:#0b0e11;color:#e6eaf0;padding:48px;text-align:center">
       <h2 style="color:${ok ? '#2ecc71' : '#ff5c5c'}">${title}</h2>
       <p>${msg}</p>
       <p><a style="color:#00d09c" href="http://localhost:8888/rh.tradingbot/">← Back to rh.tradingbot</a></p>
       </body></html>`;
    if (!code) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('Authorization failed', error || 'No code returned', false));
      return;
    }
    try {
      const status = await rh.completeAuth(code);
      await audit('rh.auth', `Robinhood OAuth completed → ${status}`);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('✓ Robinhood connected', 'Tokens saved. You can close this tab.', true));
    } catch (e: any) {
      await audit('rh.auth.error', e?.message || String(e));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('Authorization error', e?.message || String(e), false));
    }
  });
  server.on('error', (e: any) => {
    // Port busy (e.g. the CLI flow is running) — ignore; not fatal.
    console.warn('[rh-auth] callback server:', e?.message);
    server = null;
  });
  server.listen(config.rh.callbackPort, () => {
    console.log(`[rh-auth] OAuth callback listening on :${config.rh.callbackPort}`);
  });
}
