import { useState } from 'react';
import { createAuthAwareFetch } from './authFetch';
import { apiPath } from './publicPath';

const localFetch = createAuthAwareFetch();
export function InflexSignIn() {
  const [message, setMessage] = useState('Sign in locally with your ChatGPT plan to start Inflex.');
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    try {
      const response = await localFetch(apiPath('/api/v1/inflex/sign-ins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        typeof payload !== 'object' ||
        !payload ||
        !('data' in payload) ||
        typeof payload.data !== 'object' ||
        !payload.data ||
        !('authorization_url' in payload.data) ||
        typeof payload.data.authorization_url !== 'string'
      ) {
        throw new Error('Local sign-in could not start. Check the native Keychain helper and diagnostics.');
      }
      setMessage('Complete sign-in in your browser, then reload Inflex.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="boot-screen">
      <div style={{ maxWidth: '32rem', padding: '2rem' }}>
        <h1>Inflex</h1>
        <p>{message}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void signIn();
          }}
        >
          Sign in with ChatGPT
        </button>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload after sign-in
        </button>
      </div>
    </main>
  );
}
