import { describe, expect, it } from 'vitest';
import {
  resolvePaneNaming,
  sanitizeWorktreeSlugFromBranch,
} from '../src/utils/paneNaming.js';

describe('pane naming resolution', () => {
  it('uses settings base branch and branch prefix by default', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'fix-auth',
      branchPrefix: 'feat/',
      baseBranchSetting: 'develop',
    });

    expect(resolved).toEqual({
      slug: 'fix-auth',
      branchName: 'feat/fix-auth',
      baseBranch: 'develop',
    });
  });

  it('lets create-time overrides win over settings', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'ignored-slug',
      branchPrefix: 'feat/',
      baseBranchSetting: 'main',
      baseBranchOverride: 'release/2026.02',
      branchNameOverride: 'feat/LIN-123-fix-auth',
    });

    expect(resolved.baseBranch).toBe('release/2026.02');
    expect(resolved.branchName).toBe('feat/LIN-123-fix-auth');
    expect(resolved.slug).toBe('feat-lin-123-fix-auth');
  });

  it('ignores branch prefix when explicit branch override is provided', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'ignored',
      branchPrefix: 'feat/',
      branchNameOverride: 'hotfix/LIN-42',
    });

    expect(resolved.branchName).toBe('hotfix/LIN-42');
    expect(resolved.slug).toBe('hotfix-lin-42');
  });

  it('applies multi-agent suffix to both branch and slug', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'lin-123-fix-auth',
      branchNameOverride: 'feat/LIN-123-fix-auth',
      slugSuffix: 'claude-code',
    });

    expect(resolved.branchName).toBe('feat/LIN-123-fix-auth-claude-code');
    expect(resolved.slug).toBe('feat-lin-123-fix-auth-claude-code');
  });

  it('does not append duplicate suffixes', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'fix-auth-claude-code',
      slugSuffix: 'claude-code',
    });

    expect(resolved.branchName).toBe('fix-auth-claude-code');
    expect(resolved.slug).toBe('fix-auth-claude-code');
  });

  it('falls back to generated slug when base branch is unset', () => {
    const resolved = resolvePaneNaming({
      generatedSlug: 'plain-slug',
    });

    expect(resolved.baseBranch).toBe('');
    expect(resolved.branchName).toBe('plain-slug');
    expect(resolved.slug).toBe('plain-slug');
  });
});

describe('sanitizeWorktreeSlugFromBranch', () => {
  it('normalizes branch paths into flat worktree-safe names', () => {
    expect(sanitizeWorktreeSlugFromBranch('feat/LIN-999 Add Auth')).toBe('feat-lin-999-add-auth');
  });

  it('falls back to pane when branch contains no usable chars', () => {
    expect(sanitizeWorktreeSlugFromBranch('////')).toBe('pane');
  });

  it('does not produce dot-directory slugs', () => {
    expect(sanitizeWorktreeSlugFromBranch('.')).toBe('pane');
    expect(sanitizeWorktreeSlugFromBranch('.hidden')).toBe('hidden');
  });
});
