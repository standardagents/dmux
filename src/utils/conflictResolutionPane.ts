/**
 * Conflict Resolution Pane Creation
 *
 * Utilities for creating a new pane specifically for AI-assisted merge conflict resolution
 */

import type { DmuxPane } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  enforceControlPaneSize,
  ensurePaneBorderStatusForCurrentSession,
  splitPane,
} from './tmux.js';
import { capturePaneContent } from './paneCapture.js';
import { SIDEBAR_WIDTH } from './layoutManager.js';
import { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY } from '../constants/timing.js';
import {
  buildPromptReadAndDeleteSnippet,
  deletePromptFile,
  writePromptFile,
} from './promptStore.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import {
  buildAgentCommand,
  buildInitialPromptCommand,
  getAgentProcessName,
  getPromptTransport,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  type AgentName,
} from './agentLaunch.js';
import { sendPromptViaTmux } from './agentPromptDispatch.js';
import { resolveProjectColorTheme } from './paneColors.js';

export interface ConflictResolutionPaneOptions {
  sourceBranch: string;      // Branch being merged (the worktree branch)
  targetBranch: string;      // Branch merging into (usually main)
  targetRepoPath: string;    // Path to the target repository (where merge will happen)
  agent: AgentName;
  projectName: string;
  existingPanes: DmuxPane[];
}

/**
 * Create a pane for resolving merge conflicts with AI assistance
 */
export async function createConflictResolutionPane(
  options: ConflictResolutionPaneOptions
): Promise<DmuxPane> {
  const { sourceBranch, targetBranch, targetRepoPath, agent, projectName, existingPanes } = options;
  const tmuxService = TmuxService.getInstance();
  const { SettingsManager } = await import('./settingsManager.js');
  const settings = new SettingsManager(targetRepoPath).getSettings();

  // Generate slug for this conflict resolution session
  const slug = `merge-${sourceBranch}-into-${targetBranch}`.substring(0, 50);

  // Get current pane info
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Get current pane count
  const paneCount = tmuxService.getAllPaneIdsSync().length;

  // Enable pane borders to show titles
  try {
    ensurePaneBorderStatusForCurrentSession();
  } catch {
    // Ignore if already set or fails
  }

  // Create new pane
  const paneInfo = splitPane();

  // Wait for pane creation to settle
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Set pane title
  try {
    await tmuxService.setPaneTitle(paneInfo, slug);
  } catch {
    // Ignore if setting title fails
  }

  // Don't apply global layouts - just enforce sidebar width
  try {
    const controlPaneId = tmuxService.getCurrentPaneIdSync();
    await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
  } catch {}

  // CD into the target repository (where we'll resolve conflicts)
  try {
    await tmuxService.sendShellCommand(paneInfo, `cd "${targetRepoPath}"`);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error('[conflictResolutionPane] Failed to cd into target repo:', error);
  }

  // CRITICAL: Ensure clean state before starting merge
  // If a previous merge attempt left MERGE_HEAD, abort it first
  try {
    await tmuxService.sendShellCommand(paneInfo, 'git merge --abort 2>/dev/null || true');
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error('[conflictResolutionPane] Failed to abort previous merge:', error);
  }

  // CRITICAL: Start the merge to create conflict markers for the agent to resolve
  // This is necessary because pre-validation or failed execution may have aborted the merge
  try {
    await tmuxService.sendShellCommand(paneInfo, `git merge ${targetBranch} --no-edit || true`);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, TMUX_LAYOUT_APPLY_DELAY));
  } catch (error) {
    console.error('[conflictResolutionPane] Failed to initiate merge:', error);
  }

  // Construct the AI prompt for conflict resolution
  const prompt = `There are conflicts merging ${targetBranch} into ${sourceBranch}. Both are valid changes, so please keep both feature sets and merge them intelligently. Check git status to see the conflicting files, then resolve each conflict to preserve both sets of changes. Once all conflicts are resolved, commit the merge.`;
  const shouldSendPromptViaTmux = getPromptTransport(agent) === 'send-keys';

  let promptFilePath: string | null = null;
  if (!shouldSendPromptViaTmux) {
    try {
      promptFilePath = await writePromptFile(targetRepoPath, slug, prompt);
    } catch {
      // Fall back to escaped inline flows if prompt file creation fails
    }
  }

  // Launch agent with the conflict resolution prompt
  {
    if (agent === 'gemini') {
      ensureGeminiFolderTrusted(targetRepoPath);
    }

    let baselineCommand: string | undefined;
    if (shouldSendPromptViaTmux) {
      try {
        baselineCommand = await tmuxService.getPaneCurrentCommand(paneInfo);
      } catch {
        baselineCommand = undefined;
      }
    }

    let launchCommand: string;
    if (promptFilePath && !shouldSendPromptViaTmux) {
      const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
      launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
        agent,
        '"$DMUX_PROMPT_CONTENT"',
        settings.permissionMode
      )}`;
      promptFilePath = null;
    } else {
      const escapedPrompt = prompt
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      launchCommand = buildInitialPromptCommand(
        agent,
        `"${escapedPrompt}"`,
        settings.permissionMode
      );
    }

    if (!launchCommand) {
      launchCommand = buildAgentCommand(agent, settings.permissionMode);
    }

    await tmuxService.sendShellCommand(paneInfo, launchCommand);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

    if (shouldSendPromptViaTmux) {
      await sendPromptViaTmux({
        paneId: paneInfo,
        prompt,
        tmuxService,
        expectedCommand: getAgentProcessName(agent),
        baselineCommand,
        prePromptKeys: getSendKeysPrePrompt(agent),
        submitKeys: getSendKeysSubmit(agent),
        postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
        readyDelayMs: getSendKeysReadyDelayMs(agent),
      });
    }

    if (agent === 'claude') {
      // Auto-approve trust prompts for Claude (workspace trust, not edit permissions)
      autoApproveTrustPrompt(paneInfo).catch(() => {
        // Ignore errors in background monitoring
      });
    }
  }

  if (promptFilePath) {
    await deletePromptFile(promptFilePath);
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Create the pane object
  const newPane: DmuxPane = {
    id: `dmux-${Date.now()}`,
    slug,
    prompt,
    paneId: paneInfo,
    projectRoot: targetRepoPath,
    projectName,
    colorTheme: resolveProjectColorTheme(targetRepoPath, []),
    agent,
    // Note: No worktreePath - this pane operates directly in the target repo
  };

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the title for the dmux pane
  try {
    await tmuxService.setPaneTitle(originalPaneId, "dmux");
  } catch {
    // Ignore if setting title fails
  }

  return newPane;
}

/**
 * Auto-approve Claude trust prompts (reused from paneCreation.ts)
 */
async function autoApproveTrustPrompt(paneInfo: string): Promise<void> {
  // Wait longer for Claude to start up before checking for prompts
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100;
  const checkInterval = 100;
  let lastContent = '';
  let stableContentCount = 0;
  let promptHandled = false;

  // Trust prompt patterns - made more specific to avoid false positives
  const trustPromptPatterns = [
    // Specific trust/permission questions
    /Do you trust the files in this folder\?/i,
    /Trust the files in this workspace\?/i,
    /Do you trust the authors of the files/i,
    /Do you want to trust this workspace\?/i,
    /trust.*files.*folder/i,
    /trust.*workspace/i,
    /Trust this folder/i,
    /trust.*directory/i,
    /workspace.*trust/i,
    // Claude-specific numbered menu format
    /❯\s*1\.\s*Yes,\s*proceed/i,
    /Enter to confirm.*Esc to exit/i,
    /1\.\s*Yes,\s*proceed/i,
    /2\.\s*No,\s*exit/i,
  ];

  for (let i = 0; i < maxChecks; i++) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));

    try {
      const paneContent = capturePaneContent(paneInfo, 30);

      // Early exit: If Claude is already running (prompt has been processed), we're done
      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

      if (paneContent === lastContent) {
        stableContentCount++;
      } else {
        stableContentCount = 0;
        lastContent = paneContent;
      }

      // Look for trust prompt using specific patterns only
      const hasTrustPrompt = trustPromptPatterns.some((pattern) =>
        pattern.test(paneContent)
      );

      // Only act if we have high confidence it's a trust prompt
      if (hasTrustPrompt && !promptHandled) {
        // Require content to be stable for longer to avoid false positives
        if (stableContentCount >= 5) {
          const isNewClaudeFormat =
            /❯\s*1\.\s*Yes,\s*proceed/i.test(paneContent) ||
            /Enter to confirm.*Esc to exit/i.test(paneContent);

          if (isNewClaudeFormat) {
            const tmuxService = TmuxService.getInstance();
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          } else {
            const tmuxService = TmuxService.getInstance();
            await tmuxService.sendTmuxKeys(paneInfo, 'y');
            await new Promise((resolve) => setTimeout(resolve, 50));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
            await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          }

          promptHandled = true;
          await new Promise((resolve) => setTimeout(resolve, 500));

          const updatedContent = capturePaneContent(paneInfo, 10);

          const promptGone = !trustPromptPatterns.some((p) =>
            p.test(updatedContent)
          );

          if (promptGone) {
            break;
          }
        }
      }
    } catch {
      // Continue checking
    }
  }
}
