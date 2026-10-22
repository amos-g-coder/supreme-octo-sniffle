import { GoalModeSchema, ThinkingTierSchema } from '@truefoundry/trueforge-core/core';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import configuration from '../config';
import { inflexDoctor } from './router';

export async function inflexCommand(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  if (!command || command.startsWith('-') || command === 'serve') {
    return false;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      model: { type: 'string' },
      goal: { type: 'string', default: 'standard' },
      thinking: { type: 'string', default: 'balanced' },
      session: { type: 'string' },
    },
  });
  const port = Number(values.port ?? configuration.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid local server port');
  }
  const base = `http://127.0.0.1:${String(port)}/api/v1`;
  const request = async (resource: string, body: unknown) => {
    const response = await fetch(base + resource, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`Inflex request failed (${String(response.status)}): ${await response.text()}`);
    }
    return await response.json();
  };
  if (command === 'doctor') {
    console.log(JSON.stringify(await inflexDoctor(), null, 2));
    return true;
  }
  if (command === 'login') {
    const result = z
      .object({ data: z.object({ authorization_url: z.string() }) })
      .parse(await request('/inflex/sign-ins', {}));
    console.log(`Open this URL to sign in locally:\n${result.data.authorization_url}`);
    return true;
  }
  if (command !== 'run') {
    throw new Error(`Unknown Inflex command: ${command}`);
  }
  const task = positionals.join(' ').trim();
  if (!task) {
    throw new Error('Provide a task: inflex run "your task"');
  }
  const goal = GoalModeSchema.parse(values.goal);
  const thinking = ThinkingTierSchema.parse(values.thinking);
  let model = values.model;
  model ??= z
    .object({ data: z.array(z.object({ name: z.string() })) })
    .parse(await request('/models', undefined))
    .data.find(candidate => candidate.name.startsWith('chatgpt/'))?.name;
  if (!model) {
    throw new Error('No authenticated model is available; run inflex login');
  }
  const sessionId =
    values.session ??
    z.object({ data: z.object({ id: z.string() }) }).parse(
      await request('/sessions', {
        agent: {
          spec: {
            model: { name: model },
            config: { inflex: { goal_mode: goal, thinking_tier: thinking }, sandbox: { enabled: false } },
          },
        },
      }),
    ).data.id;
  console.error(`Session: ${sessionId}`);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    let input: unknown[] = [{ type: 'user.message', content: task }];
    for (;;) {
      const response = await fetch(`${base}/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input, stream: true }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Turn failed (${String(response.status)}): ${await response.text()}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const approvals: unknown[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          buffer += decoder.decode(part.value instanceof Uint8Array ? part.value : undefined, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event
              .split('\n')
              .find(line => line.startsWith('data:'))
              ?.slice(5);
            if (!data) {
              continue;
            }
            const parsed = z
              .object({ type: z.string(), thread_id: z.string().optional(), tool_call_id: z.string().optional() })
              .loose()
              .parse(JSON.parse(data));
            if (parsed.type === 'tool.approval_required' && parsed.thread_id && parsed.tool_call_id) {
              console.error(JSON.stringify(parsed));
              const answer = await terminal.question('Allow this tool call? [y/N] ');
              approvals.push({
                type: 'user.tool_approval',
                thread_id: parsed.thread_id,
                tool_call_id: parsed.tool_call_id,
                approval: { status: /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny' },
              });
            } else {
              console.log(JSON.stringify(parsed));
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!approvals.length) {
        break;
      }
      input = approvals;
    }
  } finally {
    terminal.close();
  }
  return true;
}
