import type { AgentDefinition } from '../../src/core';
import { EventType } from '../../src/core/events/schema';
import { inflexCapability } from '../../src/core/inflex/capability';
import { GoalStateSchema } from '../../src/core/inflex/goals';
import { InflexSettingsSchema } from '../../src/core/inflex/policy';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import { runTurn } from './helpers/helpers';

it('Advanced forces evidence-backed goal disposition before completing the session', async () => {
  const replies = [
    null,
    { operation: 'intent', from: ['origin'], description: 'Verify the arithmetic' },
    {
      operation: 'conclude',
      intent_id: 'i1',
      evidence: { description: '2 + 2 evaluates to 4', references: ['arithmetic-check'] },
    },
    {
      operation: 'complete',
      facts: ['f1'],
      acceptance_evidence: [{ description: 'Answer verified', references: ['arithmetic-check'] }],
    },
    null,
  ];
  let requests = 0;
  async function* response(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    const command = replies[requests++];
    if (requests > 6) throw new Error('Goal execution did not converge');
    yield {
      id: 'delta',
      model: 'test',
      object: 'chat.completion.chunk',
      created: 0,
      choices: [{ index: 0, delta: { content: command ? '' : 'Four' }, finish_reason: null }],
    };
    return {
      output: {
        role: 'assistant',
        content: command ? null : 'Four',
        ...(command
          ? {
              tool_calls: [
                {
                  id: `call-${requests}`,
                  type: 'function',
                  function: { name: 'goal', arguments: JSON.stringify(command) },
                },
              ],
            }
          : {}),
      },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: command ? 'tool_calls' : 'stop',
    };
  }
  const definition: AgentDefinition = {
    modelName: 'test/model',
    modelClient: { create: response, createNonStream: jest.fn() },
    inflex: InflexSettingsSchema.parse({ goal_mode: 'advanced' }),
    inflexStrategy: 'cairn',
  };
  const capability = inflexCapability({ definition, isChild: false, tracing: NOOP_AGENT_TRACING });
  const root = new AgentThread({
    definition,
    threadId: 'main',
    title: 'Goal task',
    capabilities: capability ? [capability] : [],
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([['main', root]]),
    createDynamicSubAgentThread: () => Promise.reject(new Error('This goal fixture must not delegate')),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const { result, events } = await runTurn({
    orchestrator,
    sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is 2 + 2?' }],
  });
  expect(requests).toBe(5);
  expect(result.root_agent_error).toBeUndefined();
  const states = events
    .filter(event => event.type === InternalEventType.CAPABILITY_STATE)
    .map(event => GoalStateSchema.parse(event.state));
  expect(states.at(-1)?.status).toBe('completed');
  expect(states.at(-1)?.facts.some(fact => fact.id === 'f1')).toBe(true);
  expect(result.output?.content).toBe('Four');
});
