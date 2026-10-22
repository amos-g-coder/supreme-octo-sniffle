import type { GoalState } from './goals';

// Adapted from Cairn's bootstrap/reason/explore prompts under AGPL-3.0-only.
export function cairnPhaseGuidance(state: GoalState): string {
  if (state.status === 'stopped') {
    return 'The goal is paused. Report the blocker and preserved evidence. Resume only when new information or authorization resolves it.';
  }
  if (state.status === 'completed') {
    return 'The goal has completion evidence. Integrate the result and report the proof and limitations. Reopen the board if verification reveals a gap.';
  }
  if (state.phase === 'bootstrap') {
    return 'Bootstrap: inspect the Origin, Goal and Hints. Establish the actual starting position from objective evidence. Declare an intent from origin, explore the smallest useful experiment, and conclude with confirmed facts. A partial result does not establish completion.';
  }
  const open = state.intents.filter(intent => intent.outcome === null);
  if (state.phase === 'explore' && open.length) {
    return `Explore: advance only the assigned open intents (${open.map(intent => intent.id).join(', ')}). Verify objective results through available tools, retain large evidence as artifacts, and conclude each intent with a concise confirmed fact. Negative experimental results are useful facts. Preserve unresolved blockers explicitly.`;
  }
  return 'Reason: first judge whether confirmed facts satisfy every acceptance criterion. Complete only with direct evidence. Otherwise compare open intents with existing facts and hints; course-correct when the task has drifted. Propose a small number of valuable, distinct exploration directions. When no intents remain, propose the next experiment or pause with a concrete blocker. Delegate only partitioned work, then integrate its evidence into the same board.';
}
