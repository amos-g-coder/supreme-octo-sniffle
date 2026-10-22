import { newEventId } from '../events/schema';
import type { RawAssistantMessage } from '../llm/LLMTypes';
import type { MappedMCPTool } from '../mcp/convertMCPServers';
import type { ContextMessage } from '../runtime/AgentThread.types';
import { GoalStateSchema } from './goals';

export function ensureUltraContribution(input: {
  output: RawAssistantMessage;
  context: readonly ContextMessage[];
  tool_mapping: Map<string, MappedMCPTool>;
}): RawAssistantMessage {
  if (input.output.tool_calls?.length) {
    return input.output;
  }
  const taskStart = input.context.findLastIndex(message => 'role' in message && message.role === 'user');
  const context = input.context.slice(Math.max(0, taskStart));
  const delegated = new Set<string>();
  for (const message of context) {
    if ('role' in message && message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call.tool_info.is_thread_creation) {
          delegated.add(call.id);
        }
      }
    }
    if ('role' in message && message.role === 'tool' && delegated.has(message.tool_call_id)) {
      return input.output;
    }
  }
  const tool = [...input.tool_mapping].find(([, value]) => value.originalToolName === 'create_sub_agent');
  if (!tool) {
    throw new Error('Ultra requires delegation, but its delegation capability is unavailable');
  }
  const task = context.find(message => 'role' in message && message.role === 'user');
  const taskText =
    task && 'content' in task ? JSON.stringify(task.content).slice(0, 12000) : 'Verify the assigned task';
  return {
    ...input.output,
    tool_calls: [
      {
        id: `inflex_${newEventId()}`,
        type: 'function',
        function: {
          name: tool[0],
          arguments: JSON.stringify({
            name: 'Independent verification',
            strategy: 'standard',
            input: `Check one concrete assumption or the correctness of this candidate result. Do not repeat the whole task or modify files. Return a concise finding with evidence and limitations.\nTask: ${taskText}\nCandidate: ${JSON.stringify(input.output.content).slice(0, 12000)}`,
            charter: {
              objective: 'Verify the candidate result against the assigned task',
              owned_paths: [],
              read_only: true,
              acceptance: ['Return a concrete verification finding and evidence'],
            },
          }),
        },
      },
    ],
  };
}

export function requireGoalDisposition(input: {
  output: RawAssistantMessage;
  state: unknown;
  tool_mapping: Map<string, MappedMCPTool>;
}): RawAssistantMessage {
  if (input.output.tool_calls?.length) {
    return input.output;
  }
  const state = GoalStateSchema.parse(input.state);
  if (state.status !== 'active') {
    return input.output;
  }
  const tool = [...input.tool_mapping].find(([, value]) => value.originalToolName === 'goal');
  if (!tool) {
    throw new Error('Goal-driven execution requires its goal capability');
  }
  return {
    ...input.output,
    tool_calls: [
      {
        id: `goal_${newEventId()}`,
        type: 'function',
        function: { name: tool[0], arguments: JSON.stringify({ operation: 'read' }) },
      },
    ],
  };
}
