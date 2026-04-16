import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction, PaneAction } from '../../src/actions/index.js';
import { createPullRequest } from '../../src/actions/implementations/createPullRequestAction.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { createShellPane, createWorktreePane } from '../fixtures/mockPanes.js';
import { expectChoice, expectConfirm, expectError, expectInfo, expectSuccess } from '../helpers/actionAssertions.js';

const mocked = vi.hoisted(() => ({
  getGitStatus: vi.fn(),
  hasCommitsToMerge: vi.fn(),
  resolveMergeTarget: vi.fn(),
  handleCommitWithOptions: vi.fn(),
  createGitHubPullRequest: vi.fn(),
}));

vi.mock('../../src/utils/mergeValidation.js', () => ({
  getGitStatus: mocked.getGitStatus,
  hasCommitsToMerge: mocked.hasCommitsToMerge,
}));

vi.mock('../../src/utils/mergeTargets.js', () => ({
  resolveMergeTarget: mocked.resolveMergeTarget,
}));

vi.mock('../../src/actions/merge/commitMessageHandler.js', () => ({
  handleCommitWithOptions: mocked.handleCommitWithOptions,
}));

vi.mock('../../src/utils/githubPullRequest.js', () => ({
  createGitHubPullRequest: mocked.createGitHubPullRequest,
}));

describe('createPullRequestAction', () => {
  const mergeTarget = {
    target: {
      slug: 'main',
      branchName: 'main',
      worktreePath: '/test/project',
    },
    targetRepoPath: '/test/project',
    targetBranch: 'main',
    targetLabel: '"main"',
    requiresConfirmation: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getGitStatus.mockReturnValue({
      hasChanges: false,
      files: [],
      summary: '',
    });
    mocked.hasCommitsToMerge.mockReturnValue(true);
    mocked.resolveMergeTarget.mockReturnValue(mergeTarget);
    mocked.handleCommitWithOptions.mockResolvedValue({
      type: 'success',
      message: 'Committed changes',
      dismissable: true,
    });
    mocked.createGitHubPullRequest.mockReturnValue({
      url: 'https://github.com/acme/repo/pull/123',
      created: true,
      remoteName: 'origin',
    });
  });

  it('returns an error for panes without a worktree', async () => {
    const pane = createShellPane();
    const context = createMockContext([pane]);

    const result = await createPullRequest(pane, context);

    expectError(result, 'no worktree');
  });

  it('returns an error when no valid PR target can be resolved', async () => {
    const pane = createWorktreePane();
    const context = createMockContext([pane]);
    mocked.resolveMergeTarget.mockReturnValue(null);

    const result = await createPullRequest(pane, context);

    expectError(result, 'valid pull request target');
  });

  it('returns info when there are no committed changes to open in a PR', async () => {
    const pane = createWorktreePane({ slug: 'feature/api-cleanup' });
    const context = createMockContext([pane]);
    mocked.hasCommitsToMerge.mockReturnValue(false);

    const result = await createPullRequest(pane, context);

    expectInfo(result, 'No committed changes');
    expect(result.message).toContain('feature/api-cleanup');
  });

  it('prompts to commit uncommitted changes before creating a PR', async () => {
    const pane = createWorktreePane();
    const context = createMockContext([pane]);
    mocked.getGitStatus.mockReturnValue({
      hasChanges: true,
      files: ['src/app.ts'],
      summary: ' M src/app.ts',
    });

    const result = await createPullRequest(pane, context);

    expectChoice(result, 4);
    expect(result.title).toBe('Worktree Has Uncommitted Changes');
    expect(result.data).toMatchObject({
      kind: 'merge_uncommitted',
      repoPath: pane.worktreePath,
      targetBranch: 'main',
      files: ['src/app.ts'],
    });

    await result.onSelect?.('commit_manual');

    expect(mocked.handleCommitWithOptions).toHaveBeenCalledWith(
      pane.worktreePath,
      'commit_manual',
      expect.any(Function)
    );
  });

  it('returns a confirmation dialog before creating a PR', async () => {
    const pane = createWorktreePane({ displayName: 'Review Queue' });
    const context = createMockContext([pane]);

    const result = await createPullRequest(pane, context);

    expectConfirm(result);
    expect(result.title).toBe('Create Pull Request');
    expect(result.confirmLabel).toBe('Create PR');
    expect(result.message).toContain('Review Queue');
    expect(result.message).toContain('"main"');
  });

  it('creates a PR when the confirmation is accepted', async () => {
    const pane = createWorktreePane({ branchName: 'feature/review-queue' });
    const context = createMockContext([pane]);
    const result = await createPullRequest(pane, context);

    const submitResult = await result.onConfirm?.();

    expectSuccess(submitResult!, 'Created PR');
    expect(mocked.createGitHubPullRequest).toHaveBeenCalledWith({
      repoPath: pane.worktreePath,
      sourceBranch: 'feature/review-queue',
      targetBranch: 'main',
    });
  });

  it('surfaces an existing PR instead of treating it as a failure', async () => {
    const pane = createWorktreePane({ branchName: 'feature/review-queue' });
    const context = createMockContext([pane]);
    mocked.createGitHubPullRequest.mockReturnValue({
      url: 'https://github.com/acme/repo/pull/123',
      created: false,
      remoteName: 'origin',
    });

    const result = await createPullRequest(pane, context);
    const submitResult = await result.onConfirm?.();

    expectSuccess(submitResult!, 'PR already exists');
  });

  it('returns an error result when GitHub PR creation fails', async () => {
    const pane = createWorktreePane();
    const context = createMockContext([pane]);
    mocked.createGitHubPullRequest.mockImplementation(() => {
      throw new Error('GitHub CLI auth failed');
    });

    const result = await createPullRequest(pane, context);
    const submitResult = await result.onConfirm?.();

    expectError(submitResult!, 'GitHub CLI auth failed');
  });

  it('uses a fallback confirmation when the original PR target is unavailable', async () => {
    const pane = createWorktreePane({ displayName: 'Child Task' });
    const context = createMockContext([pane]);
    mocked.resolveMergeTarget.mockReturnValue({
      ...mergeTarget,
      requiresConfirmation: true,
      fallbackReason: 'merged',
      fallbackFrom: {
        slug: 'feature-parent',
        branchName: 'feature-parent',
        worktreePath: '/test/project/.dmux/worktrees/feature-parent',
      },
    });

    const result = await createPullRequest(pane, context);

    expectConfirm(result);
    expect(result.title).toBe('Parent PR Target Unavailable');
    expect(result.message).toContain('already been merged upstream');
    expect(result.message).toContain('Child Task');
  });

  it('routes the create_pr dispatcher entry to the PR action', async () => {
    const pane = createWorktreePane();
    const context = createMockContext([pane]);

    const result = await executeAction(PaneAction.CREATE_PR, pane, context);

    expectConfirm(result);
    expect(result.title).toBe('Create Pull Request');
  });
});
