import { z } from '@hono/zod-openapi';

export const GoalModeSchema = z.enum(['standard', 'enhanced', 'advanced']);
export const ThinkingTierSchema = z.enum(['light', 'balanced', 'deep', 'intensive', 'ultra']);
export const ExecutionStrategySchema = z.enum(['standard', 'cairn']);
export const InflexSettingsSchema = z
  .object({
    goal_mode: GoalModeSchema.default('standard'),
    thinking_tier: ThinkingTierSchema.default('balanced'),
    workspace: z.string().min(1).optional(),
    soft_token_target: z.number().int().positive().optional(),
  })
  .strict()
  .openapi('InflexSettings');
export const TaskCharterSchema = z
  .object({
    objective: z.string().trim().min(1),
    owned_paths: z.array(z.string().min(1)).default([]),
    acceptance: z.array(z.string().min(1)).min(1),
    read_only: z.boolean().default(true),
    unresolved_reason: z.string().trim().min(1).optional(),
  })
  .strict()
  .openapi('TaskCharter');
export type GoalMode = z.infer<typeof GoalModeSchema>;
export type ThinkingTier = z.infer<typeof ThinkingTierSchema>;
export type ExecutionStrategy = z.infer<typeof ExecutionStrategySchema>;
export type InflexSettings = z.infer<typeof InflexSettingsSchema>;
export type TaskCharter = z.infer<typeof TaskCharterSchema>;

export interface ThinkingPolicy {
  max_children: number;
  mandatory_delegation: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  allocation_multiplier: number;
}

export const THINKING_POLICIES: Record<ThinkingTier, ThinkingPolicy> = {
  light: { max_children: 1, mandatory_delegation: false, effort: 'low', allocation_multiplier: 1 },
  balanced: { max_children: 2, mandatory_delegation: false, effort: 'medium', allocation_multiplier: 2 },
  deep: { max_children: 3, mandatory_delegation: false, effort: 'high', allocation_multiplier: 3 },
  intensive: { max_children: 4, mandatory_delegation: false, effort: 'xhigh', allocation_multiplier: 4 },
  ultra: { max_children: 4, mandatory_delegation: true, effort: 'xhigh', allocation_multiplier: 5 },
};

export function resolveStrategy(input: {
  settings: InflexSettings;
  requested: ExecutionStrategy;
  charter: TaskCharter | undefined;
}): ExecutionStrategy {
  if (input.settings.goal_mode === 'standard') {
    if (input.requested === 'cairn') {
      throw new Error('Standard mode does not enable goal-search functionality');
    }
    return 'standard';
  }
  if (input.settings.goal_mode === 'advanced') {
    return 'cairn';
  }
  if (input.requested === 'cairn' && !input.charter?.unresolved_reason) {
    throw new Error('Enhanced exploration requires a specific unresolved subgoal');
  }
  return input.requested;
}

export function thinkingEffort(input: { tier: ThinkingTier; supported: readonly string[] }): string | undefined {
  const order = ['low', 'medium', 'high', 'xhigh'];
  const requested = order.indexOf(THINKING_POLICIES[input.tier].effort);
  return order
    .slice(0, requested + 1)
    .reverse()
    .find(effort => input.supported.includes(effort));
}

export interface BudgetAdvice {
  soft_target: number;
  consumed: number;
  pressure: number;
  new_children: number;
  guidance: string;
}

export function reasonBudget(input: {
  settings: InflexSettings;
  context_tokens: number;
  consumed_tokens: number;
  child_completed: boolean;
}): BudgetAdvice {
  const policy = THINKING_POLICIES[input.settings.thinking_tier];
  const target =
    input.settings.soft_token_target ?? Math.max(8192, input.context_tokens * 4) * policy.allocation_multiplier;
  const pressure = input.consumed_tokens / target;
  const required = policy.mandatory_delegation && !input.child_completed;
  return {
    soft_target: target,
    consumed: input.consumed_tokens,
    pressure,
    new_children: required ? 1 : pressure >= 1 ? 0 : pressure >= 0.75 ? 1 : policy.max_children,
    guidance:
      pressure >= 1
        ? 'The reasoning estimate has been exceeded. Continue the task, favor completion and integration, reuse evidence, and avoid redundant exploration. Required Ultra verification still applies.'
        : 'Partition independent work before delegation. Reserve reasoning capacity for verification and integration.',
  };
}
