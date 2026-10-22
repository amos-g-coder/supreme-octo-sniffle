import { createGoal, updateGoal } from '../../../src/core/inflex/goals';
import {
  InflexSettingsSchema,
  reasonBudget,
  resolveStrategy,
  THINKING_POLICIES,
  thinkingEffort,
} from '../../../src/core/inflex/policy';

describe('Inflex execution policy', () => {
  it.each(['light', 'balanced', 'deep', 'intensive', 'ultra'])(
    'keeps Standard independent of thinking level %s',
    tier => {
      const settings = InflexSettingsSchema.parse({ thinking_tier: tier });
      expect(resolveStrategy({ settings, requested: 'standard', charter: undefined })).toBe('standard');
      expect(() => resolveStrategy({ settings, requested: 'cairn', charter: undefined })).toThrow('Standard');
    },
  );
  it('requires a specific unresolved subgoal before enabling Enhanced exploration', () => {
    const settings = InflexSettingsSchema.parse({ goal_mode: 'enhanced' });
    expect(resolveStrategy({ settings, requested: 'standard', charter: undefined })).toBe('standard');
    expect(() => resolveStrategy({ settings, requested: 'cairn', charter: undefined })).toThrow('unresolved');
    expect(
      resolveStrategy({
        settings,
        requested: 'cairn',
        charter: {
          objective: 'Find a viable solver',
          owned_paths: [],
          acceptance: ['Demonstrate convergence'],
          read_only: true,
          unresolved_reason: 'Existing methods diverge',
        },
      }),
    ).toBe('cairn');
  });
  it('uses full goal reasoning throughout Advanced', () => {
    expect(
      resolveStrategy({
        settings: InflexSettingsSchema.parse({ goal_mode: 'advanced' }),
        requested: 'standard',
        charter: undefined,
      }),
    ).toBe('cairn');
  });
  it('adapts effort to the supported catalog and never invents ultra provider effort', () => {
    expect(thinkingEffort({ tier: 'ultra', supported: ['low', 'high'] })).toBe('high');
    expect(thinkingEffort({ tier: 'light', supported: ['high'] })).toBeUndefined();
    expect(THINKING_POLICIES.ultra.mandatory_delegation).toBe(true);
  });
  it('reduces speculative fanout after a soft estimate while preserving Ultra delegation', () => {
    const advice = reasonBudget({
      settings: InflexSettingsSchema.parse({ thinking_tier: 'ultra', soft_token_target: 100 }),
      context_tokens: 50,
      consumed_tokens: 500,
      child_completed: false,
    });
    expect(advice.new_children).toBe(1);
    expect(advice.guidance).toContain('Continue the task');
    expect(
      reasonBudget({
        settings: InflexSettingsSchema.parse({ soft_token_target: 100 }),
        context_tokens: 50,
        consumed_tokens: 500,
        child_completed: true,
      }).new_children,
    ).toBe(0);
  });
});

describe('goal evidence lifecycle', () => {
  it('persists a scoped fact graph and validates completion without modifying prior snapshots', () => {
    const origin = createGoal({
      scope_id: 'child-a',
      origin: 'Repair solver',
      goal: 'Convergent solver',
      acceptance: ['Residual below threshold'],
    });
    const exploring = updateGoal({
      state: origin,
      command: { operation: 'intent', from: ['origin'], description: 'Run convergence experiment' },
    });
    expect(origin.intents).toHaveLength(0);
    expect(() =>
      updateGoal({
        state: exploring,
        command: {
          operation: 'complete',
          facts: ['origin'],
          acceptance_evidence: [{ description: 'Claim', references: ['claim'] }],
        },
      }),
    ).toThrow();
    const reasoned = updateGoal({
      state: exploring,
      command: {
        operation: 'conclude',
        intent_id: 'i1',
        evidence: { description: 'Residual 1e-8', references: ['artifacts/residual.json'] },
      },
    });
    const completed = updateGoal({
      state: reasoned,
      command: {
        operation: 'complete',
        facts: ['f1'],
        acceptance_evidence: [{ description: 'Residual verified', references: ['artifacts/residual.json'] }],
      },
    });
    expect(completed.status).toBe('completed');
    expect(completed.scope_id).toBe('child-a');
    expect(updateGoal({ state: completed, command: { operation: 'reopen', reason: 'New boundary case' } }).status).toBe(
      'active',
    );
    expect(completed.status).toBe('completed');
  });
  it('rejects duplicate unresolved exploration and permits pause/resume with evidence intact', () => {
    const origin = createGoal({ scope_id: 'root', origin: 'Task', goal: 'Goal', acceptance: ['Evidence'] });
    const command = { operation: 'intent', from: ['origin'], description: 'Try method' };
    const exploring = updateGoal({ state: origin, command: { ...command, operation: 'intent' } });
    expect(() => updateGoal({ state: exploring, command: { ...command, operation: 'intent' } })).toThrow(
      'already exists',
    );
    const paused = updateGoal({ state: exploring, command: { operation: 'pause' } });
    expect(updateGoal({ state: paused, command: { operation: 'resume' } }).intents).toEqual(exploring.intents);
  });
});
