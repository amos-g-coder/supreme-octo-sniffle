import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { runProcess } from './process';

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
  client_id: z.string(),
  scopes: z.array(z.string()),
});
type Token = z.infer<typeof TokenSchema>;
const ExchangeSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});
export interface CredentialStore {
  read(): Promise<Token | null>;
  write(token: Token): Promise<void>;
  remove(): Promise<void>;
}

/** Secrets cross the native helper's stdin, never command arguments or browser storage. */
export class KeychainStore implements CredentialStore {
  constructor(private readonly helper: string) {}
  private async request(operation: 'read' | 'write' | 'delete', value: string | undefined): Promise<string> {
    if (process.platform !== 'darwin') {
      throw new Error('Inflex OAuth credentials require the macOS Keychain helper');
    }
    const result = await runProcess({
      command: this.helper,
      args: [],
      cwd: '/',
      signal: undefined,
      stdin: JSON.stringify({ operation, value }),
      max_bytes: 64_000,
    });
    if (result.exit_code !== 0) {
      throw new Error('Keychain access failed; build the Inflex native helper');
    }
    return result.stdout;
  }
  async read(): Promise<Token | null> {
    const result = await this.request('read', undefined);
    return result.trim() ? TokenSchema.parse(JSON.parse(result)) : null;
  }
  async write(token: Token): Promise<void> {
    await this.request('write', JSON.stringify(token));
  }
  async remove(): Promise<void> {
    await this.request('delete', undefined);
  }
}

export class ChatGPTOAuth {
  private cached: Token | null | undefined;
  private reading: Promise<Token | null> | undefined;
  private async readCredential(): Promise<Token | null> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    const generation = this.generation;
    this.reading ??= this.options.store
      .read()
      .then(token => {
        if (generation === this.generation) {
          this.cached = token;
        }
        return this.cached ?? null;
      })
      .finally(() => {
        this.reading = undefined;
      });
    return await this.reading;
  }
  private refresh: Promise<Token> | undefined;
  private starting: Promise<{ authorization_url: string }> | undefined;
  private generation = 0;
  private mutation: Promise<void> = Promise.resolve();
  private login: { url: string; close: () => void } | undefined;
  constructor(private readonly options: { store: CredentialStore; data_dir: string; fetch: typeof fetch }) {}
  async status(): Promise<{ authenticated: boolean; login_pending: boolean }> {
    return {
      authenticated: (await this.readCredential()) !== null,
      login_pending: this.login !== undefined || this.starting !== undefined,
    };
  }
  async logout(): Promise<void> {
    this.generation++;
    this.cached = null;
    this.login?.close();
    this.login = undefined;
    const removal = this.mutation.then(() => this.options.store.remove());
    this.mutation = removal.catch(() => {
      /* Cleanup or queue recovery must preserve the original operation result. */
    });
    await removal;
  }
  async accessToken(): Promise<string> {
    const current = await this.readCredential();
    if (current && !current.scopes.includes('chatgpt.tokens.use.direct')) {
      throw new Error('Enable ChatGPT plan usage by signing in again');
    }
    if (!current) {
      throw new Error('Sign in to ChatGPT locally before starting inference');
    }
    if (current.expires_at > Date.now() + 60_000) {
      return current.access_token;
    }
    this.refresh ??= (async () => {
      const latest = await this.readCredential();
      if (!latest) {
        throw new Error('Sign in to ChatGPT locally before starting inference');
      }
      if (latest.expires_at > Date.now() + 60_000) {
        return latest;
      }
      return await this.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: latest.refresh_token,
          client_id: latest.client_id,
        }),
        latest,
      );
    })().finally(() => {
      this.refresh = undefined;
    });
    return (await this.refresh).access_token;
  }
  private async exchange(body: URLSearchParams, previous: Token | null): Promise<Token> {
    const generation = this.generation;
    const expectedNonce = body.get('inflex_nonce');
    body.delete('inflex_nonce');
    body.set('resource', 'https://api.openai.com/v1');
    const response = await this.options.fetch('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`ChatGPT authentication failed (${String(response.status)}); sign in again if necessary`);
    }
    const result = ExchangeSchema.parse(await response.json());
    const refreshToken = result.refresh_token ?? previous?.refresh_token;
    const client = body.get('client_id');
    if (!refreshToken || !client) {
      throw new Error('Authentication response omitted its durable grant');
    }
    const scopes = result.scope?.split(/\s+/) ?? previous?.scopes ?? [];
    if (!scopes.includes('chatgpt.tokens.use.direct')) {
      throw new Error('ChatGPT plan usage was not granted; sign in again and enable plan usage');
    }
    const token = {
      scopes,
      access_token: result.access_token,
      refresh_token: refreshToken,
      expires_at: Date.now() + result.expires_in * 1000,
      client_id: client,
    };
    if (body.get('grant_type') === 'authorization_code') {
      if (!result.id_token || !expectedNonce) {
        throw new Error('Authentication response omitted identity verification');
      }
      const discovery = z.object({ issuer: z.string(), jwks_uri: z.url() }).parse(
        await (
          await this.options.fetch('https://auth.openai.com/.well-known/openid-configuration', {
            signal: AbortSignal.timeout(15_000),
          })
        ).json(),
      );
      if (!discovery.jwks_uri.startsWith('https://auth.openai.com/')) {
        throw new Error('Untrusted identity key endpoint');
      }
      const verified = await jwtVerify(
        result.id_token,
        createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: this.options.fetch }),
        {
          issuer: 'https://auth.openai.com',
          audience: client,
        },
      );
      if (verified.payload['nonce'] !== expectedNonce) {
        throw new Error('Identity nonce did not match');
      }
    }
    const write = this.mutation.then(async () => {
      if (generation !== this.generation) {
        throw new Error('Sign-in was cancelled');
      }
      await this.options.store.write(token);
      if (generation === this.generation) {
        this.cached = token;
      }
    });
    this.mutation = write.catch(() => {
      /* Cleanup or queue recovery must preserve the original operation result. */
    });
    await write;
    return token;
  }
  begin(): Promise<{ authorization_url: string }> {
    this.starting ??= this.openLogin().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async openLogin(): Promise<{ authorization_url: string }> {
    if (this.login) {
      return { authorization_url: this.login.url };
    }
    await mkdir(this.options.data_dir, { recursive: true, mode: 0o700 });
    const hostFile = path.join(this.options.data_dir, 'oauth-host-id');
    let hostId: string;
    try {
      hostId = (await readFile(hostFile, 'utf8')).trim();
    } catch (error) {
      if (!z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
        throw error;
      }
      hostId = `urn:uuid:${randomUUID()}`;
      await writeFile(hostFile, hostId, { mode: 0o600 });
    }
    const previous = await this.readCredential();
    const clientIdentity = previous?.client_id ?? 'dynamic_agent_client';
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (incoming.pathname !== '/auth/callback') {
            response.writeHead(404).end();
            return;
          }
          const returnedState = incoming.searchParams.get('state') ?? '';
          if (
            Buffer.byteLength(returnedState) !== Buffer.byteLength(state) ||
            !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
          ) {
            response.writeHead(400).end('Invalid sign-in state');
            return;
          }
          const code = incoming.searchParams.get('code');
          const clientId =
            incoming.searchParams.get('client_id') ??
            (clientIdentity === 'dynamic_agent_client' ? null : clientIdentity);
          if (
            clientId === 'dynamic_agent_client' ||
            (clientIdentity !== 'dynamic_agent_client' && clientId !== clientIdentity)
          ) {
            throw new Error('Unexpected OAuth client identity');
          }
          if (!code || !clientId) {
            throw new Error('Sign-in was denied or omitted the issued client identity');
          }
          await this.exchange(
            new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: clientId,
              redirect_uri: redirect,
              code_verifier: verifier,
              inflex_nonce: nonce,
            }),
            null,
          );
          response
            .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
            .end('Inflex sign-in complete. You can close this window.');
        } catch {
          response
            .writeHead(400, { 'Content-Type': 'text/plain' })
            .end('Sign-in could not be completed. Return to Inflex and try again.');
        } finally {
          close();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Could not open the local sign-in callback');
    }
    const redirect = `http://127.0.0.1:${String(address.port)}/auth/callback`;
    const timer = setTimeout(() => {
      close();
    }, 10 * 60_000);
    timer.unref();
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      this.login = undefined;
    };
    const url = new URL('https://auth.openai.com/api/accounts/authorize');
    url.search = new URLSearchParams({
      client_id: clientIdentity,
      ...(clientIdentity === 'dynamic_agent_client' ? { agent_name_hint: 'Inflex' } : {}),
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    this.login = { url: url.toString(), close };
    return { authorization_url: url.toString() };
  }
}
