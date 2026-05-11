import { describe, expect, it } from 'vitest';
import {
  getNextNewPaneField,
  getPreviousNewPaneField,
} from '../src/components/popups/newPaneFieldNavigation.js';

describe('new pane field navigation', () => {
  it('cycles forward prompt -> base -> branch -> prompt', () => {
    expect(getNextNewPaneField('prompt')).toBe('baseBranch');
    expect(getNextNewPaneField('baseBranch')).toBe('branchName');
    expect(getNextNewPaneField('branchName')).toBe('prompt');
  });

  it('cycles backward prompt <- base <- branch <- prompt', () => {
    expect(getPreviousNewPaneField('prompt')).toBe('branchName');
    expect(getPreviousNewPaneField('branchName')).toBe('baseBranch');
    expect(getPreviousNewPaneField('baseBranch')).toBe('prompt');
  });

  it('includes linked repo selection in the cycle when child repos are available', () => {
    expect(getNextNewPaneField('branchName', { hasLinkedRepos: true })).toBe('linkedRepos');
    expect(getNextNewPaneField('linkedRepos', { hasLinkedRepos: true })).toBe('prompt');
    expect(getPreviousNewPaneField('prompt', { hasLinkedRepos: true })).toBe('linkedRepos');
    expect(getPreviousNewPaneField('linkedRepos', { hasLinkedRepos: true })).toBe('branchName');
  });
});
