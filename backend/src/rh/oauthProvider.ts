import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';

type Store = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

/**
 * File-backed OAuth client provider for the Robinhood agentic MCP server.
 * - Persists dynamic client registration, PKCE verifier, and tokens to disk.
 * - The transport auto-refreshes the access token from the refresh token.
 * - First-time interactive auth is driven by `authCli.ts`.
 */
export class RhOAuthProvider implements OAuthClientProvider {
  private storePath: string;
  private cache: Store;
  /** Called when the user must visit an authorization URL. */
  public onAuthorize: (url: URL) => void | Promise<void>;
  /** Latest authorization URL, if the server needs to surface it to the UI. */
  public lastAuthUrl: URL | undefined;

  constructor(opts?: { onAuthorize?: (url: URL) => void | Promise<void> }) {
    this.storePath = config.rh.tokenStore;
    this.cache = this.load();
    this.onAuthorize =
      opts?.onAuthorize ??
      ((url) => {
        this.lastAuthUrl = url;
        console.log('\n[robinhood] Authorize here:\n' + url.toString() + '\n');
      });
  }

  private load(): Store {
    try {
      return JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Store;
    } catch {
      return {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
  }

  get redirectUrl(): string {
    return `http://localhost:${config.rh.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'rh.tradingbot',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    if (!this.cache.state) {
      this.cache.state = crypto.randomBytes(16).toString('hex');
      this.save();
    }
    return this.cache.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.cache.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.cache.clientInformation = info;
    this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.cache.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.cache.tokens = tokens;
    this.save();
  }

  saveCodeVerifier(verifier: string): void {
    this.cache.codeVerifier = verifier;
    this.save();
  }

  codeVerifier(): string {
    if (!this.cache.codeVerifier) throw new Error('No PKCE code verifier saved');
    return this.cache.codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthUrl = authorizationUrl;
    await this.onAuthorize(authorizationUrl);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.cache = {};
    else if (scope === 'tokens') delete this.cache.tokens;
    else if (scope === 'client') delete this.cache.clientInformation;
    else if (scope === 'verifier') delete this.cache.codeVerifier;
    this.save();
  }

  hasTokens(): boolean {
    return !!this.cache.tokens?.access_token;
  }
}
