/**
 * Implements the cyclic behavior for the 'new pane' tab of creating a new agent.
 *
 * Specifically, the 'prompt' -> 'base branch' -> 'new branch name' cycle.
 */

export type NewPaneField = 'prompt' | 'baseBranch' | 'branchName' | 'linkedRepos';

function getFieldOrder(hasLinkedRepos: boolean): NewPaneField[] {
  return hasLinkedRepos
    ? ['prompt', 'baseBranch', 'branchName', 'linkedRepos']
    : ['prompt', 'baseBranch', 'branchName'];
}

export function getNextNewPaneField(
  current: NewPaneField,
  options: { hasLinkedRepos?: boolean } = {}
): NewPaneField {
  const order = getFieldOrder(options.hasLinkedRepos ?? false);
  const currentIndex = order.indexOf(current);
  if (currentIndex === -1) {
    return order[0];
  }

  return order[(currentIndex + 1) % order.length];
}

export function getPreviousNewPaneField(
  current: NewPaneField,
  options: { hasLinkedRepos?: boolean } = {}
): NewPaneField {
  const order = getFieldOrder(options.hasLinkedRepos ?? false);
  const currentIndex = order.indexOf(current);
  if (currentIndex === -1) {
    return order[0];
  }

  return order[(currentIndex - 1 + order.length) % order.length];
}
