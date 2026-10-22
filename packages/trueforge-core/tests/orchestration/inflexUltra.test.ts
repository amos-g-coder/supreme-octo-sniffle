import type { AgentDefinition, CreateDynamicSubAgentThread } from '../../src/core';
import { dynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import { EventType } from '../../src/core/events/schema';
import { inflexCapability } from '../../src/core/inflex/capability';
import { InflexSettingsSchema } from '../../src/core/inflex/policy';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import { runTurn, textReplyStream } from './helpers/helpers';

it('Ultra Standard cannot finish a trivial task until a scoped child has contributed', async () => {
  const settings = InflexSettingsSchema.parse({ goal_mode: 'standard', thinking_tier: 'ultra' });
  const definition: AgentDefinition = {
    modelName: 'test/model',
    inflex: settings,
    inflexStrategy: 'standard',
    instruction: 'Inherited engineering guidance',
    modelClient: { create: jest.fn(() => textReplyStream('Four.')), createNonStream: jest.fn() },
  };
  const capability = inflexCapability({ definition, isChild: false, tracing: NOOP_AGENT_TRACING });
  const root = new AgentThread({
    definition,
    threadId: 'main',
    title: 'Task',
    capabilities: [
      dynamicSubAgents({ inflex: settings, sandboxAvailable: false, tracing: NOOP_AGENT_TRACING }),
      ...(capability ? [capability] : []),
    ],
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  let contributions = 0;
  const createChild: CreateDynamicSubAgentThread = async ({ threadId, parent, request, parentDefinition }) => {
    contributions++;
    expect(request.strategy).toBe('standard');
    expect(request.charter?.read_only).toBe(true);
    expect(request.input).toContain('Do not repeat the whole task');
    expect(parentDefinition.instruction).toContain('Inherited');
    return new AgentThread({
      definition: {
        ...parentDefinition,
        modelClient: { create: () => textReplyStream('Verified: 2 + 2 = 4.'), createNonStream: jest.fn() },
        messages: [{ role: 'user', content: request.input }],
      },
      threadId,
      title: request.name,
      parent,
      agentInfo: request,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
  };
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([['main', root]]),
    createDynamicSubAgentThread: createChild,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const { result, events } = await runTurn({
    orchestrator,
    sendBatch: [{ type: EventType.USER_MESSAGE, content: 'What is 2 + 2?' }],
  });
  expect(contributions).toBe(1);
  expect(events.some(event => event.type === EventType.THREAD_CREATED)).toBe(true);
  expect(result.output?.content).toBe('Four.');
  expect(result.root_agent_error).toBeUndefined();
});
