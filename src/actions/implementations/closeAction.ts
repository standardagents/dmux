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
import { deriveProjectRootFromWorktreePath, getPaneProjectRoot } from '../../utils/paneProject.js';
import { cleanupPromptFilesForSlug } from '../../utils/promptStore.js';
import { buildDevWatchRespawnCommand } from '../../utils/devWatchCommand.js';
import { isActiveDevSourcePath } from '../../utils/devSource.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';

const PANE_KILL_VERIFY_DELAYS_MS = [50, 150, 300];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTmuxPaneIds(output: string | Buffer): Set<string> {
  const ids = new Set<string>();

  for (const line of output.toString().split('\n')) {
    const match = line.trim().match(/^%\d+/);
    if (match) {
      ids.add(match[0]);
    }
  }

  return ids;
}

function tmuxPaneExists(paneId: string): boolean {
  try {
    const paneList = execSync('tmux list-panes -a -F "#{pane_id}"', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    return parseTmuxPaneIds(paneList).has(paneId);
  } catch {
    LogService.getInstance().debug(
      `Could not verify pane ${paneId} exists, treating as already closed`,
      'paneActions'
    );
    return false;
  }
}

async function waitForTmuxPaneToClose(paneId: string): Promise<boolean> {
  if (!tmuxPaneExists(paneId)) {
    return true;
  }

  for (const delay of PANE_KILL_VERIFY_DELAYS_MS) {
    await sleep(delay);
    if (!tmuxPaneExists(paneId)) {
      return true;
    }
  }

  return false;
}

async function killTmuxPaneReliably(pane: DmuxPane): Promise<boolean> {
  if (!tmuxPaneExists(pane.paneId)) {
    LogService.getInstance().debug(
      `Pane ${pane.paneId} already gone, skipping kill`,
      'paneActions'
    );
    return true;
  }

  try {
    execSync(`tmux kill-pane -t '${pane.paneId}'`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch (killError) {
    if (await waitForTmuxPaneToClose(pane.paneId)) {
      return true;
    }

    LogService.getInstance().error(
      `Error killing pane ${pane.paneId}`,
      'paneActions',
      pane.id,
      killError instanceof Error ? killError : undefined
    );
    return false;
  }

  if (await waitForTmuxPaneToClose(pane.paneId)) {
    return true;
  }

  LogService.getInstance().warn(
    `Pane ${pane.paneId} still exists after kill attempt`,
    'paneActions',
    pane.id
  );
  return false;
}

/**
 * Close a pane - presents options for how to close
 */
export async function closePane(
  pane: DmuxPane,
  context: ActionContext
): Promise<ActionResult> {
  const paneName = getPaneDisplayName(pane);

  // For shell panes (no worktree), close immediately without options
  if (pane.type === 'shell' || !pane.worktreePath) {
    return executeCloseOption(pane, context, 'kill_only');
  }

  const siblingPanesOnWorktree = context.panes.filter(candidate =>
    candidate.id !== pane.id &&
    isActiveDevSourcePath(candidate.worktreePath, pane.worktreePath)
  );

  if (siblingPanesOnWorktree.length > 0) {
    const siblingLabel = siblingPanesOnWorktree.length === 1
      ? '1 other pane'
      : `${siblingPanesOnWorktree.length} other panes`;
    const MAX_LISTED_SIBLINGS = 5;
    const listedSiblings = siblingPanesOnWorktree
      .slice(0, MAX_LISTED_SIBLINGS)
      .map((sibling) => `  - ${getPaneDisplayName(sibling)}`);
    const remainingSiblings = siblingPanesOnWorktree.length - listedSiblings.length;
    const remainingSiblingLine = remainingSiblings > 0
      ? [`  - +${remainingSiblings} more`]
      : [];

    return {
      type: 'choice',
      title: 'Close Pane',
      message: [
        `This worktree is still in use by ${siblingLabel}.`,
        'Other panes on this worktree:',
        ...listedSiblings,
        ...remainingSiblingLine,
      ].join('\n'),
      options: [
        {
          id: 'kill_only',
          label: 'Just close pane',
          description: 'Keep worktree and branch',
          default: true,
        },
      ],
      onSelect: async (optionId: string) => {
        return executeCloseOption(pane, context, optionId);
      },
      dismissable: true,
    };
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
    message: `How do you want to close "${paneName}"?`,
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
  const paneName = getPaneDisplayName(pane);
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

      const updatedPanes = context.panes.filter(p => p.id !== pane.id);

      // Kill and verify the tmux pane before mutating pane state or deleting
      // the worktree. Sending C-c first can drop an agent back to a shell if
      // kill-pane fails, so close the pane directly and treat a surviving pane
      // as a failed close.
      const paneClosed = await killTmuxPaneReliably(pane);
      if (!paneClosed) {
        return {
          type: 'error',
          message: `Failed to close pane "${paneName}"; worktree cleanup was not started`,
          dismissable: true,
        };
      }

      // Remove from config only after tmux confirms the pane is gone. The
      // lifecycle close marker suppresses recreation while the close is in
      // progress.
      await context.savePanes(updatedPanes);

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
            `Skipping worktree cleanup for ${paneName}: ${siblingPanes.length} sibling(s) still using ${pane.worktreePath}`,
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
        await context.onPaneRemove(pane.paneId); // Pass tmux pane ID, not dmux ID
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

      const hasRemainingPaneForWorktree = Boolean(
        pane.worktreePath &&
        updatedPanes.some(candidate =>
          isActiveDevSourcePath(candidate.worktreePath, pane.worktreePath)
        )
      );

      // Dev source fallback:
      // If the pane being closed is the current dev source worktree and no
      // sibling panes remain on that worktree, respawn the control pane from
      // the root checkout.
      if (
        process.env.DMUX_DEV === 'true' &&
        pane.worktreePath &&
        isActiveDevSourcePath(pane.worktreePath, process.cwd()) &&
        !hasRemainingPaneForWorktree
      ) {
        try {
          const fallbackCommand = buildDevWatchRespawnCommand(sessionProjectRoot);
          const quotedCommand = `'${fallbackCommand.replace(/'/g, "'\\''")}'`;
          const configForRespawn: DmuxConfig = JSON.parse(fs.readFileSync(panesFile, 'utf-8'));
          const targetControlPaneId = configForRespawn.controlPaneId || execSync(
            'tmux display-message -p "#{pane_id}"',
            { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }
          ).trim();

          if (targetControlPaneId) {
            execSync(
              `tmux respawn-pane -k -t '${targetControlPaneId}' ${quotedCommand}`,
              { stdio: 'pipe', timeout: 5000 }
            );
          }
        } catch (respawnError) {
          LogService.getInstance().warn(
            'Failed to respawn dev source at root after closing source pane',
            'paneActions',
            pane.id
          );
        }
      }

      return {
        type: 'success',
        message: startedBackgroundCleanup
          ? `Pane "${paneName}" closed successfully (cleanup running in background)`
          : `Pane "${paneName}" closed successfully`,
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
