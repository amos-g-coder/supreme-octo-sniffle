import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTLLM } from '../../../src/inflex/gateway';
import { ChatGPTOAuth, type CredentialStore } from '../../../src/inflex/oauth';

function credentials(): CredentialStore {
  let token = {
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    expires_at: Date.now() + 3_600_000,
    client_id: 'issued-test-client',
    scopes: ['chatgpt.tokens.use.direct'],
  };
  return {
    read: () => Promise.resolve(token),
    write: value => {
      token = value;
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
}
function stream(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
it('translates completed Responses into tool calls and replays encrypted reasoning without unsupported overrides', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-auth-'));
  try {
    const auth = new ChatGPTOAuth({ store: credentials(), data_dir: directory, fetch });
    let requestBody: unknown;
    const upstream: typeof fetch = (_url, init) => {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      return Promise.resolve(
        stream([
          { type: 'response.output_text.delta', delta: 'Checking.' },
          {
            type: 'response.completed',
            response: {
              id: 'r1',
              status: 'completed',
              output: [
                { type: 'reasoning', id: 'reason1', encrypted_content: 'opaque', summary: [] },
                { type: 'function_call', call_id: 'call1', name: 'read_file', arguments: '{"path":"README.md"}' },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ]),
      );
    };
    const llm = new ChatGPTLLM({ auth, model: 'catalog-model', fetch: upstream, signal: new AbortController().signal });
    const result = await llm.createNonStream({
      messages: [
        { role: 'system', content: 'Engineering guidance' },
        { role: 'user', content: 'Inspect the repository' },
      ],
      max_tokens: 10,
      temperature: 0.1,
      reasoning_effort: 'high',
    });
    expect(requestBody).toMatchObject({
      model: 'catalog-model',
      instructions: 'Engineering guidance',
      store: false,
      stream: true,
      reasoning: { effort: 'high' },
    });
    expect(requestBody).not.toHaveProperty('temperature');
    expect(requestBody).not.toHaveProperty('max_output_tokens');
    expect(result.output.tool_calls?.[0]?.id).toBe('call1');
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.output.thinking_blocks?.[0]?.type).toBe('redacted_thinking');
    expect(llm.getUsage().total_tokens).toBe(15);
    const replay = {
      role: 'assistant' as const,
      content: result.output.content ?? '',
      tool_calls: result.output.tool_calls ?? [],
      thinking_blocks: result.output.thinking_blocks ?? [],
    };
    await llm.createNonStream({
      messages: [
        { role: 'user', content: 'Continue' },
        replay,
        { role: 'tool', tool_call_id: 'call1', content: 'Repository details' },
      ],
    });
    expect(requestBody).toHaveProperty(
      'input',
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call1' }),
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('rejects a partial stream before exposing any executable tool result', async () => {
  const auth = new ChatGPTOAuth({ store: credentials(), data_dir: '/tmp', fetch });
  const upstream: typeof fetch = () =>
    Promise.resolve(stream([{ type: 'response.output_text.delta', delta: 'Partial answer' }]));
  const llm = new ChatGPTLLM({ auth, model: 'catalog-model', fetch: upstream, signal: new AbortController().signal });
  await expect(llm.createNonStream({ messages: [{ role: 'user', content: 'Task' }] })).rejects.toThrow(
    'before completion',
  );
});
it('serializes token refresh and retains rotated credentials without exposing them through status', async () => {
  const store = credentials();
  const current = await store.read();
  if (!current) throw new Error('Missing test credential');
  await store.write({ ...current, expires_at: 0 });
  let exchanges = 0;
  const upstream: typeof fetch = (_url, init) => {
    exchanges++;
    expect(String(init?.body)).toContain('resource=https%3A%2F%2Fapi.openai.com%2Fv1');
    return Promise.resolve(
      Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
    );
  };
  const auth = new ChatGPTOAuth({ store, data_dir: '/tmp', fetch: upstream });
  expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['rotated-access', 'rotated-access']);
  expect(exchanges).toBe(1);
  expect(await auth.status()).toEqual({ authenticated: true, login_pending: false });
});

it('completes the local PKCE callback only after validating a signed identity and the plan scope', async () => {
  const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'inflex-test', alg: 'RS256', use: 'sig' };
  const directory = await mkdtemp(path.join(tmpdir(), 'inflex-signin-'));
  let saved: Awaited<ReturnType<CredentialStore['read']>> = null;
  const store: CredentialStore = {
    read: () => Promise.resolve(saved),
    write: value => {
      saved = value;
      return Promise.resolve();
    },
    remove: () => {
      saved = null;
      return Promise.resolve();
    },
  };
  let nonce = '';
  let exchanged = false;
  const upstream: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe('issued-inflex-test');
      expect(form.get('code_verifier')).toBeTruthy();
      expect(form.has('inflex_nonce')).toBe(false);
      exchanged = true;
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'inflex-test' })
        .setIssuer('https://auth.openai.com')
        .setAudience('issued-inflex-test')
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({
        access_token: 'signed-access',
        refresh_token: 'signed-refresh',
        expires_in: 3600,
        id_token: idToken,
        scope: 'openid offline_access chatgpt.tokens.use.direct',
      });
    }
    if (url.includes('.well-known'))
      return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test-jwks' });
    if (url.endsWith('/test-jwks')) return Response.json({ keys: [publicJwk] });
    throw new Error('Unexpected authentication endpoint');
  };
  const auth = new ChatGPTOAuth({ store, data_dir: directory, fetch: upstream });
  try {
    const [first, repeated] = await Promise.all([auth.begin(), auth.begin()]);
    expect(first.authorization_url).toBe(repeated.authorization_url);
    const authorization = new URL(first.authorization_url);
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    nonce = authorization.searchParams.get('nonce') ?? '';
    const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state') ?? '',
      code: 'test-code',
      client_id: 'issued-inflex-test',
    }).toString();
    const result = await fetch(callback);
    expect(result.status).toBe(200);
    expect(exchanged).toBe(true);
    expect(await auth.accessToken()).toBe('signed-access');
    expect(await auth.status()).toEqual({ authenticated: true, login_pending: false });
  } finally {
    await auth.logout();
    await rm(directory, { recursive: true, force: true });
  }
});
