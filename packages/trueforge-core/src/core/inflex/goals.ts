import { z } from '@hono/zod-openapi';

// Adapted from Cairn's AGPL-3.0 fact/intent/hint protocol, without worker claim leases.
export const GoalEvidenceSchema = z.object({
  description: z.string().trim().min(1),
  references: z.array(z.string().min(1)).min(1),
});
export const GoalFactSchema = GoalEvidenceSchema.extend({ id: z.string(), created_at: z.string() });
export const GoalIntentSchema = z.object({
  id: z.string(),
  from: z.array(z.string()).min(1),
  description: z.string().trim().min(1),
  outcome: z.string().nullable(),
  created_at: z.string(),
});
export const GoalStateSchema = z.object({
  scope_id: z.string(),
  goal: z.string().trim().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  status: z.enum(['active', 'stopped', 'completed']),
  phase: z.enum(['bootstrap', 'reason', 'explore']),
  facts: z.array(GoalFactSchema),
  intents: z.array(GoalIntentSchema),
  hints: z.array(z.object({ content: z.string(), created_at: z.string() })),
  completion_facts: z.array(z.string()),
  revision: z.number().int().nonnegative(),
});
export type GoalState = z.infer<typeof GoalStateSchema>;
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>;

export function createGoal(input: { scope_id: string; origin: string; goal: string; acceptance: string[] }): GoalState {
  return GoalStateSchema.parse({
    scope_id: input.scope_id,
    goal: input.goal,
    acceptance: input.acceptance,
    status: 'active',
    phase: 'bootstrap',
    facts: [
      { id: 'origin', description: input.origin, references: ['user-task'], created_at: new Date().toISOString() },
    ],
    intents: [],
    hints: [],
    completion_facts: [],
    revision: 0,
  });
}

export const GoalCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('intent'), from: z.array(z.string()).min(1), description: z.string().trim().min(1) }),
  z.object({ operation: z.literal('conclude'), intent_id: z.string(), evidence: GoalEvidenceSchema }),
  z.object({ operation: z.literal('hint'), content: z.string().trim().min(1) }),
  z.object({
    operation: z.literal('complete'),
    facts: z.array(z.string()).min(1),
    acceptance_evidence: z.array(GoalEvidenceSchema).min(1),
  }),
  z.object({ operation: z.literal('pause') }),
  z.object({ operation: z.literal('resume') }),
  z.object({ operation: z.literal('reopen'), reason: z.string().trim().min(1) }),
]);
export type GoalCommand = z.infer<typeof GoalCommandSchema>;

export function updateGoal(input: { state: GoalState; command: GoalCommand }): GoalState {
  const state = structuredClone(input.state);
  const command = input.command;
  const now = new Date().toISOString();
  if (command.operation === 'hint') {
    state.hints.push({ content: command.content, created_at: now });
  } else if (command.operation === 'pause') {
    if (state.status !== 'active') {
      throw new Error('Only an active goal may be paused');
    }
    state.status = 'stopped';
  } else if (command.operation === 'resume') {
    if (state.status !== 'stopped') {
      throw new Error('Only a stopped goal may resume');
    }
    state.status = 'active';
  } else if (command.operation === 'reopen') {
    if (state.status !== 'completed') {
      throw new Error('Only a completed goal may reopen');
    }
    state.status = 'active';
    state.phase = 'reason';
    state.completion_facts = [];
    state.hints.push({ content: command.reason, created_at: now });
  } else {
    if (state.status !== 'active') {
      throw new Error('Goal is not active');
    }
    if (command.operation === 'intent') {
      if (command.from.some(id => !state.facts.some(fact => fact.id === id))) {
        throw new Error('Unknown source fact');
      }
      if (state.intents.some(intent => intent.description === command.description && intent.outcome === null)) {
        throw new Error('This unresolved intent already exists; reuse it');
      }
      state.intents.push({
        id: `i${String(state.intents.length + 1)}`,
        from: [...new Set(command.from)],
        description: command.description,
        outcome: null,
        created_at: now,
      });
      state.phase = 'explore';
    } else if (command.operation === 'conclude') {
      const intent = state.intents.find(item => item.id === command.intent_id);
      if (intent?.outcome !== null) {
        throw new Error('Intent is missing or already concluded');
      }
      const fact = { ...command.evidence, id: `f${String(state.facts.length)}`, created_at: now };
      state.facts.push(fact);
      intent.outcome = fact.id;
      state.phase = 'reason';
    } else {
      if (command.facts.some(id => id === 'origin' || !state.facts.some(fact => fact.id === id))) {
        throw new Error('Completion requires confirmed result facts');
      }
      if (state.intents.some(intent => intent.outcome === null)) {
        throw new Error('Conclude outstanding intents before completion');
      }
      if (command.acceptance_evidence.length !== state.acceptance.length) {
        throw new Error('Provide evidence for every acceptance criterion in order');
      }
      state.status = 'completed';
      state.completion_facts = [...new Set(command.facts)];
      state.hints.push({
        content: JSON.stringify({ acceptance_evidence: command.acceptance_evidence }),
        created_at: now,
      });
    }
  }
  state.revision++;
  return state;
}
