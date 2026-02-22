/**
 * MERGE Action - Merge a worktree into the main branch with comprehensive pre-checks
 *
 * This is the simplified orchestrator that delegates to specialized modules.
 * Supports multi-merge: detects sub-worktrees and merges them all sequentially.
 */

import { execSync } from 'child_process';
import type { DmuxPane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import { triggerHook } from '../../utils/hooks.js';
import { getPaneBranchName } from '../../utils/git.js';
import { executeMerge } from '../merge/mergeExecution.js';
import {
  handleNothingToMerge,
  handleMainDirty,
  handleWorktreeUncommitted,
  handleMergeConflict,
} from '../merge/issueHandlers/index.js';
import { LogService } from '../../services/LogService.js';

/**
 * Merge a worktree into the main branch with comprehensive pre-checks.
 * Supports multi-merge: if sub-worktrees exist, merges all of them sequentially.
 */
export async function mergePane(
  pane: DmuxPane,
  context: ActionContext,
  params?: { mainBranch?: string }
): Promise<ActionResult> {
  // 1. Validation
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree to merge',
      dismissable: true,
    };
  }

  // 2. Detect all worktrees (including sub-worktrees created by hooks)
  const { detectAllWorktrees } = await import('../../utils/worktreeDiscovery.js');
  const worktrees = detectAllWorktrees(pane.worktreePath);

  console.error(`[mergeAction] Detected ${worktrees.length} worktree(s) in ${pane.worktreePath}`);
  for (const wt of worktrees) {
    console.error(`[mergeAction]   - ${wt.repoName} (${wt.branch}) at ${wt.relativePath} [depth=${wt.depth}, isRoot=${wt.isRoot}]`);
  }

  // 3. Build merge queue (only worktrees with changes)
  const { buildMergeQueue, executeMultiMerge } = await import('../merge/multiMergeOrchestrator.js');
  const queue = await buildMergeQueue(worktrees);

  console.error(`[mergeAction] Merge queue has ${queue.length} item(s)`);

  // 4. Handle based on queue size
  // No changes anywhere
  if (queue.length === 0) {
    return {
      type: 'info',
      message: 'No changes to merge in any repository',
      dismissable: true,
    };
  }

  // Single root worktree = use existing flow (backwards compatible)
  if (queue.length === 1 && queue[0].worktree.isRoot) {
    console.error('[mergeAction] Single root worktree - using existing flow');
    return executeSingleRootMerge(pane, context, params);
  }

  // Multiple worktrees or only sub-worktrees = use multi-merge flow
  console.error('[mergeAction] Multiple worktrees or sub-worktrees - using multi-merge flow');
  return executeMultiMerge(pane, context, queue);
}

/**
 * Execute single root worktree merge (original flow, backwards compatible)
 */
async function executeSingleRootMerge(
  pane: DmuxPane,
  context: ActionContext,
  params?: { mainBranch?: string }
): Promise<ActionResult> {
  const { validateMerge } = await import('../../utils/mergeValidation.js');
  const mainRepoPath = pane.worktreePath!.replace(/\/\.dmux\/worktrees\/[^/]+$/, '');
  const validation = validateMerge(mainRepoPath, pane.worktreePath!, getPaneBranchName(pane));

  // Handle detected issues
  if (!validation.canMerge) {
    return handleMergeIssues(pane, context, validation, mainRepoPath);
  }

  // Check for sibling panes sharing the same worktree
  const siblingPanes = context.panes.filter(
    p => p.id !== pane.id && p.worktreePath === pane.worktreePath
  );

  // Helper to kill sibling tmux panes and remove them from config
  const closeSiblings = async () => {
    for (const sibling of siblingPanes) {
      try {
        execSync(`tmux kill-pane -t '${sibling.paneId}'`, { stdio: 'pipe', timeout: 5000 });
      } catch {
        // Pane may already be gone
      }
    }
    // Remove siblings from saved panes
    const withoutSiblings = context.panes.filter(
      p => !siblingPanes.some(s => s.id === p.id)
    );
    await context.savePanes(withoutSiblings);
    LogService.getInstance().info(
      `Closed ${siblingPanes.length} sibling pane(s) for merge of ${pane.slug}`,
      'mergeAction',
    );
  };

  // Helper that produces the merge confirmation flow
  const buildMergeConfirmation = async (): Promise<ActionResult> => {
    return {
      type: 'confirm',
      title: 'Merge Worktree',
      message: `Merge "${pane.slug}" into ${validation.mainBranch}?`,
      confirmLabel: 'Merge',
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        await triggerHook('pre_merge', mainRepoPath, pane, {
          DMUX_TARGET_BRANCH: validation.mainBranch,
        });
        return executeMerge(pane, context, validation.mainBranch, mainRepoPath);
      },
      onCancel: async () => ({
        type: 'info' as const,
        message: 'Merge cancelled',
        dismissable: true,
      }),
    };
  };

  // If siblings exist, show warning first, then proceed with normal merge flow
  if (siblingPanes.length > 0) {
    const siblingNames = siblingPanes.map(s => s.slug).join(', ');
    return {
      type: 'confirm',
      title: 'Sibling Agents Active',
      message: `${siblingPanes.length} other agent(s) (${siblingNames}) are using this worktree. Merging will close them all. Proceed?`,
      confirmLabel: 'Continue',
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        await closeSiblings();
        return buildMergeConfirmation();
      },
      onCancel: async () => ({
        type: 'info' as const,
        message: 'Merge cancelled',
        dismissable: true,
      }),
    };
  }

  // No siblings — proceed with standard merge flow
  return buildMergeConfirmation();
}

/**
 * Handle detected merge issues by delegating to specialized handlers
 */
async function handleMergeIssues(
  pane: DmuxPane,
  context: ActionContext,
  validation: any,
  mainRepoPath: string
): Promise<ActionResult> {
  const { issues, mainBranch } = validation;

  // Create retry function that re-runs the merge
  const retryMerge = () => mergePane(pane, context, { mainBranch });

  // Find and handle specific issue types
  const nothingToMerge = issues.find((i: any) => i.type === 'nothing_to_merge');
  if (nothingToMerge) {
    return handleNothingToMerge();
  }

  const mainDirty = issues.find((i: any) => i.type === 'main_dirty');
  if (mainDirty) {
    return handleMainDirty(mainDirty, mainBranch, mainRepoPath, pane, context, retryMerge);
  }

  const worktreeUncommitted = issues.find((i: any) => i.type === 'worktree_uncommitted');
  if (worktreeUncommitted) {
    return handleWorktreeUncommitted(worktreeUncommitted, pane, context, retryMerge);
  }

  const mergeConflict = issues.find((i: any) => i.type === 'merge_conflict');
  if (mergeConflict) {
    return handleMergeConflict(mergeConflict, mainBranch, mainRepoPath, pane, context);
  }

  // Generic fallback for unknown issues
  return {
    type: 'error',
    title: 'Merge Issues Detected',
    message: issues.map((i: any) => i.message).join('\n'),
    dismissable: true,
  };
}
