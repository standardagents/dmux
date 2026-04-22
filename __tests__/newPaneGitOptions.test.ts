import { describe, expect, it } from 'vitest';
import {
  BASE_BRANCH_ERROR_MESSAGE,
  clampSelectedIndex,
  filterBranches,
  getVisibleBranchWindow,
  isValidBaseBranchOverride,
  parseBranchList,
  resolveBaseBranchEnter,
} from '../src/components/popups/newPaneGitOptions.js';

describe('new pane git options helpers', () => {
  it('parses branch output preserving order and removing duplicates', () => {
    const parsed = parseBranchList('main\nfeature/a\nfeature/a\n\nfix/b\n');
    expect(parsed).toEqual(['main', 'feature/a', 'fix/b']);
  });

  it('filters branches case-insensitively', () => {
    const branches = ['main', 'feat/LIN-123', 'fix/BUG-100'];
    expect(filterBranches(branches, 'lin')).toEqual(['feat/LIN-123']);
    expect(filterBranches(branches, 'BUG')).toEqual(['fix/BUG-100']);
  });

  it('returns all branches when filter query is empty', () => {
    const branches = ['main', 'develop'];
    expect(filterBranches(branches, '   ')).toEqual(branches);
  });

  it('clamps selection index to valid bounds', () => {
    expect(clampSelectedIndex(-1, 3)).toBe(0);
    expect(clampSelectedIndex(1, 3)).toBe(1);
    expect(clampSelectedIndex(9, 3)).toBe(2);
    expect(clampSelectedIndex(4, 0)).toBe(0);
  });

  it('calculates a visible branch window centered around selection', () => {
    const branches = Array.from({ length: 20 }, (_, i) => `branch-${i}`);
    const window = getVisibleBranchWindow(branches, 12, 10);

    expect(window.startIndex).toBe(7);
    expect(window.visibleBranches).toHaveLength(10);
    expect(window.visibleBranches[0]).toBe('branch-7');
    expect(window.visibleBranches[9]).toBe('branch-16');
  });

  it('requires base branch override to exactly match an existing branch', () => {
    const branches = ['main', 'develop', 'release/2026.02'];

    expect(isValidBaseBranchOverride('', branches)).toBe(true);
    expect(isValidBaseBranchOverride('develop', branches)).toBe(true);
    expect(isValidBaseBranchOverride('Develop', branches)).toBe(false);
    expect(isValidBaseBranchOverride('feature/missing', branches)).toBe(false);
  });

  it('accepts highlighted branch on Enter in base-branch field', () => {
    const resolution = resolveBaseBranchEnter({
      baseBranch: 'fea',
      availableBranches: ['main', 'feature/foo'],
      filteredBranches: ['feature/foo'],
      selectedIndex: 0,
    });

    expect(resolution).toEqual({
      accepted: true,
      nextValue: 'feature/foo',
    });
  });

  it('accepts highlighted branch on Enter even with empty input', () => {
    const resolution = resolveBaseBranchEnter({
      baseBranch: '',
      availableBranches: ['main', 'feature/foo'],
      filteredBranches: ['feature/foo', 'main'],
      selectedIndex: 1,
    });

    expect(resolution).toEqual({
      accepted: true,
      nextValue: 'main',
    });
  });

  it('accepts exact typed branch when no filtered list is available', () => {
    const resolution = resolveBaseBranchEnter({
      baseBranch: 'develop',
      availableBranches: ['main', 'develop'],
      filteredBranches: [],
      selectedIndex: 0,
    });

    expect(resolution).toEqual({
      accepted: true,
      nextValue: 'develop',
    });
  });

  it('rejects invalid base branch on Enter with strict message', () => {
    const resolution = resolveBaseBranchEnter({
      baseBranch: 'missing-branch',
      availableBranches: ['main', 'develop'],
      filteredBranches: [],
      selectedIndex: 0,
    });

    expect(resolution).toEqual({
      accepted: false,
      nextValue: 'missing-branch',
      error: BASE_BRANCH_ERROR_MESSAGE,
    });
  });
});
