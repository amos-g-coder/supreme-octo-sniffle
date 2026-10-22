import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import {
  CreateTurnEventRequestSchema,
  ListSessionEventsResponseSchema,
  TurnStreamingEventSchema,
} from '../../../packages/trueforge/src/schemas/events.ts';
import {
  CreateSessionRequestSchema,
  GetSessionResponseSchema,
  ListSessionsResponseSchema,
  UpdateSessionRequestSchema,
} from '../../../packages/trueforge/src/schemas/session.ts';
import { CreateTurnRequestSchema } from '../../../packages/trueforge/src/schemas/turn.ts';

const now = '2026-10-22T12:00:00.000Z';
const sessions = new Map();
const streams = new Map();
const openResponses = new Map();
let authenticated = true;
let nextID = 1;
const makeSession = (id, title, agent) =>
  GetSessionResponseSchema.parse({
    data: {
      id,
      title,
      agent: { type: 'inline', spec: agent },
      shared: false,
      created_by_subject: { subject_id: 'fixture', subject_type: 'user', subject_display_name: 'Fixture' },
      created_at: now,
      updated_at: now,
      metrics: { total_duration_ms: 0, total_turns: 0 },
      metadata: {},
      source: null,
      last_turn_details: null,
    },
  }).data;
const defaultSpec = {
  model: { name: 'chatgpt/test' },
  config: { inflex: { goal_mode: 'standard', thinking_tier: 'balanced' }, sandbox: { enabled: false } },
};
function reset() {
  for (const response of openResponses.values()) {
    response.end();
  }
  openResponses.clear();
  sessions.clear();
  streams.clear();
  nextID = 1;
  sessions.set('history', makeSession('history', 'Engineering review', defaultSpec));
}
reset();
function event(type, fields = {}) {
  return TurnStreamingEventSchema.parse({
    type,
    id: `event-${nextID++}`,
    created_at: now,
    thread_id: 'main',
    ...fields,
  });
}
function append(turn, value) {
  streams.get(turn).events.push(value);
}
function sse(response, events, after = 0) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  events.forEach((value, index) => {
    if (index + 1 > after) {
      response.write(`id: ${index + 1}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
    }
  });
  response.end();
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
export function startFixture({ port = 18790 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.replace(/\/$/, '');
      const parts = route.split('/');
      let body = {};
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length) {
          body = JSON.parse(bytes.toString());
        }
      }
      if (route === '/__test/reset' || route === '/api/v1/inflex/test-reset') {
        reset();
        authenticated = body.authenticated !== false;
        json(response, 200, { ok: true });
        return;
      }
      if (route === '/healthz') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.headers.authorization !== 'Bearer trueforge-standalone') {
        json(response, 401, { error: { message: 'Missing credential' } });
        return;
      }
      if (route === '/api/v1/inflex/diagnostics') {
        json(response, 200, { data: { runtime: 'fixture', workspace: '/tmp/inflex-fixture' } });
        return;
      }
      if (route === '/api/v1/inflex/credentials') {
        if (request.method === 'DELETE') {
          authenticated = false;
        }
        json(response, 200, { data: { authenticated, login_pending: false } });
        return;
      }
      if (route === '/api/v1/inflex/sign-ins') {
        authenticated = true;
        json(response, 201, { data: { authorization_url: 'https://example.com/inflex-test-sign-in' } });
        return;
      }
      if (route === '/api/v1/models') {
        json(response, 200, { data: [{ name: 'chatgpt/test' }] });
        return;
      }
      if (route === '/api/v1/inflex/artifacts') {
        json(response, 200, {
          data: [
            { id: 'sample', name: 'evidence.json', url: '/api/v1/inflex/artifacts/sample', size: 17, modified_at: now },
          ],
        });
        return;
      }
      if (route === '/api/v1/inflex/artifacts/sample') {
        json(response, 200, { verified: true });
        return;
      }
      if (route === '/api/v1/sessions') {
        if (request.method === 'POST') {
          const parsed = CreateSessionRequestSchema.parse(body);
          const session = makeSession(
            `session-${nextID++}`,
            'New chat',
            'spec' in parsed.agent ? parsed.agent.spec : defaultSpec,
          );
          sessions.set(session.id, session);
          json(response, 201, { data: session });
          return;
        }
        json(
          response,
          200,
          ListSessionsResponseSchema.parse({ data: [...sessions.values()].reverse(), pagination: { limit: 50 } }),
        );
        return;
      }
      if (parts[3] === 'sessions') {
        const id = parts[4];
        const session = sessions.get(id);
        if (!session) {
          json(response, 404, { error: { message: 'Session not found' } });
          return;
        }
        if (parts.length === 5) {
          if (request.method === 'DELETE') {
            sessions.delete(id);
            response.writeHead(204);
            response.end();
            return;
          }
          if (request.method === 'PATCH') {
            const parsed = UpdateSessionRequestSchema.parse(body);
            if (parsed.title) {
              session.title = parsed.title;
            }
            if (parsed.shared !== undefined) {
              session.shared = parsed.shared;
            }
            if (parsed.agent) {
              session.agent = { type: 'inline', spec: parsed.agent.spec };
            }
          }
          json(response, 200, { data: session });
          return;
        }
        if (parts[5] === 'cancel') {
          if (session.last_turn_details) {
            const turn = session.last_turn_details.id;
            append(
              turn,
              event('turn.done', {
                thread_id: null,
                state: { status: 'cancelled', reason: 'client-cancelled', completed_at: now },
              }),
            );
            session.last_turn_details.state.status = 'cancelled';
            const live = openResponses.get(turn);
            if (live) {
              const events = streams.get(turn).events;
              live.write(`id: ${events.length}\ndata: ${JSON.stringify(events.at(-1))}\n\n`);
              live.end();
              openResponses.delete(turn);
            }
          }
          json(response, 200, {});
          return;
        }
        if (parts[5] === 'events') {
          const events = [...streams.entries()]
            .filter(([, stream]) => stream.session === id)
            .flatMap(([turn, stream]) =>
              stream.events.filter(e => e.type !== 'model.message.delta').map(e => ({ turn_id: turn, event: e })),
            )
            .reverse();
          json(response, 200, ListSessionEventsResponseSchema.parse({ data: events, pagination: { limit: 100 } }));
          return;
        }
        if (parts[5] === 'turns') {
          if (parts.length === 6 && request.method === 'POST') {
            const parsed = CreateTurnRequestSchema.parse(body);
            const turn = `turn-${nextID++}`;
            const text = JSON.stringify(parsed.input);
            session.title = parsed.input[0]?.content?.toString().slice(0, 50) || session.title;
            streams.set(turn, { session: id, events: [] });
            session.last_turn_details = { id: turn, state: { status: 'running' } };
            append(
              turn,
              event('turn.created', {
                thread_id: null,
                turn_id: turn,
                previous_turn_id: null,
                input: parsed.input,
                state: { status: 'running' },
              }),
            );
            if (text.includes('wait for stop')) {
              append(turn, event('model.message', { content: 'Working until stopped.' }));
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              streams
                .get(turn)
                .events.forEach((value, index) =>
                  response.write(`id: ${index + 1}\ndata: ${JSON.stringify(value)}\n\n`),
                );
              openResponses.set(turn, response);
              return;
            }
            if (text.includes('approval')) {
              append(
                turn,
                event('model.message', {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"example.txt"}' },
                      tool_info: { type: 'truefoundry-system', name: 'write_file' },
                    },
                  ],
                }),
              );
              const approval = event('tool.approval_required', {
                tool_calls: [{ id: 'call-1', source_event_id: streams.get(turn).events.at(-1).id }],
              });
              append(turn, approval);
              append(
                turn,
                event('turn.update', {
                  thread_id: null,
                  state: { status: 'paused', action_required_on_events: [{ id: approval.id }] },
                }),
              );
              session.last_turn_details.state.status = 'paused';
            } else {
              append(turn, event('model.message', { content: 'Native SwiftUI response — ready.' }));
              append(
                turn,
                event('turn.done', {
                  thread_id: null,
                  state: { status: 'done', output: null, required_actions: [], completed_at: now },
                }),
              );
              session.last_turn_details.state.status = 'done';
            }
            sse(response, streams.get(turn).events);
            return;
          }
          const turn = parts[6];
          const stream = streams.get(turn);
          if (stream && parts[7] === 'events' && request.method === 'POST') {
            const parsed = CreateTurnEventRequestSchema.parse(body);
            for (const input of parsed.events) {
              append(turn, event(input.type, input));
            }
            append(turn, event('turn.update', { thread_id: null, state: { status: 'running' } }));
            append(turn, event('model.message', { content: 'Approved and completed.' }));
            append(
              turn,
              event('turn.done', {
                thread_id: null,
                state: { status: 'done', output: null, required_actions: [], completed_at: now },
              }),
            );
            session.last_turn_details.state.status = 'done';
            json(response, 201, { data: [] });
            return;
          }
          if (stream && parts[7] === 'subscribe') {
            sse(response, stream.events, Number(url.searchParams.get('after_sequence_number') ?? 0));
            return;
          }
        }
      }
      if (/\/api\/v1\/(settings\/|mcp-servers|skills|agents|schedules|sandbox-environments)/.test(route)) {
        json(response, 200, { data: [], pagination: { limit: 50 } });
        return;
      }
      json(response, 404, { error: { message: 'Unknown fixture route' } });
    } catch (error) {
      json(response, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
