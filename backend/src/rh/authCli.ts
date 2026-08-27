/**
 * One-time interactive OAuth for the Robinhood agentic MCP.
 *   npm run rh:auth
 * Opens the browser, captures the redirect on the local callback port,
 * exchanges the code for tokens, and persists them to the token store.
 */
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import open from 'open';
import { config } from '../config.js';
import { RhOAuthProvider } from './oauthProvider.js';

async function main() {
  const port = config.rh.callbackPort;

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><body style="font-family:system-ui;background:#0b0e11;color:#e6e6e6;padding:40px">
         <h2>${code ? '✓ Robinhood connected' : '✗ Authorization failed'}</h2>
         <p>${code ? 'You can close this tab and return to the terminal.' : (error || 'No code returned')}</p>
         </body></html>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(error || 'no code'));
    });
    server.listen(port, () => {
      console.log(`[auth] listening for redirect on http://localhost:${port}/callback`);
    });
  });

  const provider = new RhOAuthProvider({
    onAuthorize: async (u) => {
      console.log('[auth] opening browser…');
      try {
        await open(u.toString());
      } catch {
        console.log('[auth] open this URL manually:\n' + u.toString());
      }
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(config.rh.mcpUrl), {
    authProvider: provider,
  });
  const client = new Client({ name: 'rh.tradingbot-auth', version: '0.1.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    console.log('[auth] already authorized — tokens valid.');
    await printTools(client);
    process.exit(0);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      console.error('[auth] unexpected error:', err);
      process.exit(1);
    }
  }

  // Wait for the redirect, exchange the code, then reconnect with fresh tokens.
  const code = await codePromise;
  await transport.finishAuth(code);
  console.log('[auth] code exchanged, tokens saved.');

  const transport2 = new StreamableHTTPClientTransport(new URL(config.rh.mcpUrl), {
    authProvider: provider,
  });
  const client2 = new Client({ name: 'rh.tradingbot', version: '0.1.0' }, { capabilities: {} });
  await client2.connect(transport2);
  console.log('[auth] ✓ connected to Robinhood agentic MCP.');
  await printTools(client2);
  process.exit(0);
}

async function printTools(client: Client) {
  const res = await client.listTools();
  console.log(`[auth] ${res.tools.length} tools available:`);
  for (const t of res.tools) console.log('   •', t.name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
