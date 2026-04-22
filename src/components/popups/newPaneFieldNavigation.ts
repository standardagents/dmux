/**
 * Implements the cyclic behavior for the 'new pane' tab of creating a new agent.
 *
 * Specifically, the 'prompt' -> 'base branch' -> 'new branch name' cycle.
 */

export type NewPaneField = 'prompt' | 'baseBranch' | 'branchName';

export function getNextNewPaneField(current: NewPaneField): NewPaneField {
  if (current === 'prompt') return 'baseBranch';
  if (current === 'baseBranch') return 'branchName';
  return 'prompt';
}

export function getPreviousNewPaneField(current: NewPaneField): NewPaneField {
  if (current === 'prompt') return 'branchName';
  if (current === 'baseBranch') return 'prompt';
  return 'baseBranch';
}
