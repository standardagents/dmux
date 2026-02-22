/**
 * CLOSE Action - Close a pane with various cleanup options
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import type { DmuxPane, DmuxConfig } from '../../types.js';
import type { ActionResult, ActionContext, ActionOption } from '../types.js';
import { StateManager } from '../../shared/StateManager.js';
import { PaneLifecycleManager } from '../../services/PaneLifecycleManager.js';
import { triggerHook } from '../../utils/hooks.js';
import { LogService } from '../../services/LogService.js';
import { WorktreeCleanupService } from '../../services/WorktreeCleanupService.js';
import { TMUX_SPLIT_DELAY } from '../../constants/timing.js';
import { deriveProjectRootFromWorktreePath, getPaneProjectRoot } from '../../utils/paneProject.js';
import { cleanupPromptFilesForSlug } from '../../utils/promptStore.js';
import { getPaneBranchName } from '../../utils/git.js';

/**
 * Close a pane - presents options for how to close
 */
export async function closePane(
  pane: DmuxPane,
  context: ActionContext
): Promise<ActionResult> {
  // For shell panes (no worktree), close immediately without options
  if (pane.type === 'shell' || !pane.worktreePath) {
    return executeCloseOption(pane, context, 'kill_only');
  }

  // For worktree panes, present options
  const options: ActionOption[] = [
    {
      id: 'kill_only',
      label: 'Just close pane',
      description: 'Keep worktree and branch',
      default: true,
    },
    {
      id: 'kill_and_clean',
      label: 'Close and remove worktree',
      description: 'Delete worktree but keep branch',
      danger: true,
    },
    {
      id: 'kill_clean_branch',
      label: 'Close and delete everything',
      description: 'Remove worktree and delete branch',
      danger: true,
    },
  ];

  return {
    type: 'choice',
    title: 'Close Pane',
    message: `How do you want to close "${pane.slug}"?`,
    options,
    onSelect: async (optionId: string) => {
      return executeCloseOption(pane, context, optionId);
    },
    dismissable: true,
  };
}

/**
 * Execute the selected close option
 */
async function executeCloseOption(
  pane: DmuxPane,
  context: ActionContext,
  option: string
): Promise<ActionResult> {
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const stateManager = StateManager.getInstance();
  const state = stateManager.getState();
  const sessionProjectRoot = state.projectRoot || process.cwd();
  const paneProjectRoot = getPaneProjectRoot(pane, sessionProjectRoot);
  const panesFile = state.panesFile || path.join(sessionProjectRoot, '.dmux', 'dmux.config.json');

  try {
    // CRITICAL: Mark pane as closing FIRST to prevent race condition with polling
    // This prevents usePanes from recreating the pane while we're closing it
    await lifecycleManager.beginClose(pane.id, `close action: ${option}`);
    // Also mark by paneId in case polling checks that
    await lifecycleManager.beginClose(pane.paneId, `close action: ${option}`);

    // Trigger before_pane_close hook
    await triggerHook('before_pane_close', paneProjectRoot, pane);

    // CRITICAL: Pause ConfigWatcher to prevent race condition where
    // the watcher reloads the pane list from disk before our save completes
    stateManager.pauseConfigWatcher();

    try {
      let startedBackgroundCleanup = false;

      // CRITICAL: Remove from config FIRST, before killing tmux pane
      // This prevents the race condition where polling detects "missing" pane
      // and recreates it before we finish closing
      const updatedPanes = context.panes.filter(p => p.id !== pane.id);
      await context.savePanes(updatedPanes);

      // NOW kill the tmux pane (after config is updated)
      // CRITICAL FIX: First verify the pane exists before trying to interact with it
      // This prevents crashes/hangs when operating on stale pane IDs
      let paneExists = false;
      try {
        const paneList = execSync('tmux list-panes -F "#{pane_id}"', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000 // 5 second timeout to prevent hangs
        });
        paneExists = paneList.includes(pane.paneId);
      } catch {
        // Error checking panes - assume it doesn't exist
        LogService.getInstance().debug(`Could not verify pane ${pane.paneId} exists, treating as already closed`, 'paneActions');
      }

      if (paneExists) {
        try {
          // First, try to kill any running process in the pane (like Claude)
          try {
            execSync(`tmux send-keys -t '${pane.paneId}' C-c`, {
              stdio: 'pipe',
              timeout: 2000 // 2 second timeout
            });
            // Wait a moment for the process to exit
            await new Promise(resolve => setTimeout(resolve, TMUX_SPLIT_DELAY));
          } catch {
            // Process might not be running or pane already gone
          }

          // Now kill the pane
          execSync(`tmux kill-pane -t '${pane.paneId}'`, {
            stdio: 'pipe',
            timeout: 5000 // 5 second timeout
          });

          // Verify the pane is actually gone
          await new Promise(resolve => setTimeout(resolve, 100));
          try {
            // Check if pane still exists
            const updatedPaneList = execSync('tmux list-panes -F "#{pane_id}"', {
              encoding: 'utf-8',
              stdio: 'pipe',
              timeout: 5000
            });
            if (updatedPaneList.includes(pane.paneId)) {
              const msg = `Pane ${pane.paneId} still exists after kill attempt`;
              LogService.getInstance().warn(msg, 'paneActions', pane.id);
            }
          } catch {
            // Error listing panes is fine
          }
        } catch (killError) {
          // Pane might already be dead, which is fine
          const msg = `Error killing pane ${pane.paneId}`;
          LogService.getInstance().error(msg, 'paneActions', pane.id, killError instanceof Error ? killError : undefined);
        }
      } else {
        LogService.getInstance().debug(`Pane ${pane.paneId} already gone, skipping kill`, 'paneActions');
      }

      // Best-effort cleanup of any stored prompt files for this pane slug
      // (including leftovers from interrupted launches).
      try {
        const promptCleanupRoot = pane.worktreePath
          ? (deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot)
          : paneProjectRoot;
        await cleanupPromptFilesForSlug(promptCleanupRoot, pane.slug);
      } catch {
        // Ignore prompt cleanup errors
      }

      // Handle worktree cleanup based on option
      if (pane.worktreePath && (option === 'kill_and_clean' || option === 'kill_clean_branch')) {
        // Check if sibling panes still share this worktree
        // updatedPanes already excludes the current pane, so any match = active sibling
        const siblingPanes = updatedPanes.filter(p => p.worktreePath === pane.worktreePath);
        if (siblingPanes.length > 0) {
          // Skip worktree/branch deletion — other panes still using it
          LogService.getInstance().info(
            `Skipping worktree cleanup for ${pane.slug}: ${siblingPanes.length} sibling(s) still using ${pane.worktreePath}`,
            'paneActions',
            pane.id
          );
        } else {
          const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot;

          // Trigger before_worktree_remove hook
          await triggerHook('before_worktree_remove', paneProjectRoot, pane);

          try {
            WorktreeCleanupService.getInstance().enqueueCleanup({
              pane,
              paneProjectRoot,
              mainRepoPath,
              deleteBranch: option === 'kill_clean_branch',
            });
            startedBackgroundCleanup = true;
          } catch (cleanupError) {
            LogService.getInstance().warn(
              `Failed to start background cleanup for pane ${pane.id}`,
              'paneActions',
              pane.id
            );
          }
        }
      }

      if (context.onPaneRemove) {
        context.onPaneRemove(pane.paneId); // Pass tmux pane ID, not dmux ID
      }

      // Recalculate layout for remaining panes
      // CRITICAL FIX: Use validated pane IDs, not just the ones from config
      // The config may have stale IDs if panes were killed between save and layout
      try {
        const config: DmuxConfig = JSON.parse(fs.readFileSync(panesFile, 'utf-8'));
        if (config.controlPaneId && updatedPanes.length > 0) {
          // Verify control pane exists before attempting layout
          const paneListCheck = execSync('tmux list-panes -F "#{pane_id}"', {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000
          });
          const currentPaneIds = paneListCheck.trim().split('\n').filter(Boolean);

          if (!currentPaneIds.includes(config.controlPaneId)) {
            LogService.getInstance().debug(
              `Control pane ${config.controlPaneId} no longer exists, skipping layout recalc`,
              'paneActions'
            );
          } else {
            // Filter to only panes that actually exist in tmux
            const validPaneIds = updatedPanes
              .map(p => p.paneId)
              .filter(id => currentPaneIds.includes(id));

            if (validPaneIds.length > 0) {
              const { recalculateAndApplyLayout } = await import('../../utils/layoutManager.js');
              const { getTerminalDimensions } = await import('../../utils/tmux.js');
              const dimensions = getTerminalDimensions();

              recalculateAndApplyLayout(
                config.controlPaneId,
                validPaneIds,
                dimensions.width,
                dimensions.height
              );

              LogService.getInstance().debug(
                `Recalculated layout after closing pane: ${validPaneIds.length} panes remaining`,
                'paneActions'
              );
            }
          }
        }
      } catch (error) {
        // Log but don't fail - layout recalc is non-critical
        LogService.getInstance().debug('Failed to recalculate layout after pane close', 'paneActions');
      }

      // Trigger pane_closed hook (after everything is cleaned up)
      await triggerHook('pane_closed', paneProjectRoot, pane);

      // If we just closed the last pane, recreate the welcome pane and recalculate layout
      if (updatedPanes.length === 0) {
        const { handleLastPaneRemoved } = await import('../../utils/postPaneCleanup.js');
        await handleLastPaneRemoved(sessionProjectRoot);
      }

      return {
        type: 'success',
        message: startedBackgroundCleanup
          ? `Pane "${pane.slug}" closed successfully (cleanup running in background)`
          : `Pane "${pane.slug}" closed successfully`,
        dismissable: true,
      };
    } finally {
      // CRITICAL: Always resume watcher, even if there was an error
      stateManager.resumeConfigWatcher();

      // Complete the lifecycle close (releases lock)
      // Do this AFTER resume to ensure the config is stable
      await lifecycleManager.completeClose(pane.id);
      await lifecycleManager.completeClose(pane.paneId);
    }
  } catch (error) {
    // Release lifecycle lock on error
    await lifecycleManager.completeClose(pane.id);
    await lifecycleManager.completeClose(pane.paneId);

    return {
      type: 'error',
      message: `Failed to close pane: ${error}`,
      dismissable: true,
    };
  }
}
