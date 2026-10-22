import { useState } from 'react';
import { createAuthAwareFetch } from './authFetch';
import { apiPath } from './publicPath';

const localFetch = createAuthAwareFetch();
interface Artifact {
  id: string;
  name: string;
  url: string;
}
function isArtifact(value: unknown): value is Artifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}
export function InflexMediaPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Artifact[]>([]);
  const [message, setMessage] = useState('');
  const refresh = async () => {
    try {
      const response = await localFetch(apiPath('/api/v1/inflex/artifacts'));
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        typeof payload !== 'object' ||
        !payload ||
        !('data' in payload) ||
        !Array.isArray(payload.data)
      ) {
        throw new Error('Media artifacts could not be loaded');
      }
      setItems(payload.data.filter(isArtifact));
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <aside style={{ position: 'fixed', right: '1rem', bottom: '1rem', zIndex: 60 }}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) {
            void refresh();
          }
        }}
      >
        Media
      </button>
      {open && (
        <section
          aria-label="Inflex media"
          style={{
            width: 'min(34rem, 90vw)',
            maxHeight: '75vh',
            overflow: 'auto',
            padding: '1rem',
            background: 'var(--background, #18181b)',
            color: 'var(--foreground, white)',
            borderRadius: '0.75rem',
          }}
        >
          <h2>Media and evidence</h2>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
          >
            Refresh
          </button>
          <p>{message}</p>
          {!items.length && (
            <p>
              Video analysis frames and published exports appear here. Ask Inflex to analyze footage or edit and export
              a composition.
            </p>
          )}
          {items.map(item => (
            <article key={item.id}>
              <p>
                <a href={apiPath(item.url)} target="_blank" rel="noreferrer">
                  {item.name}
                </a>
              </p>
              {/\.(mp4|webm)$/i.test(item.name) ? (
                <video controls src={apiPath(item.url)} style={{ width: '100%' }} />
              ) : /\.(wav|mp3)$/i.test(item.name) ? (
                <audio controls src={apiPath(item.url)} />
              ) : /\.(png|jpe?g|webp)$/i.test(item.name) ? (
                <img alt={item.name} src={apiPath(item.url)} style={{ maxWidth: '100%' }} loading="lazy" />
              ) : null}
            </article>
          ))}
        </section>
      )}
    </aside>
  );
}
