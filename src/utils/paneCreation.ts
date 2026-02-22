import path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { DmuxPane, DmuxConfig } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import { SIDEBAR_WIDTH, recalculateAndApplyLayout } from './layoutManager.js';
import { generateSlug } from './slug.js';
import { capturePaneContent } from './paneCapture.js';
import { triggerHook, initializeHooksDirectory } from './hooks.js';
import { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY } from '../constants/timing.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { LogService } from '../services/LogService.js';
import { appendSlugSuffix, launchAgentInPane } from './agentLaunch.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { isValidBranchName } from './git.js';

export interface CreatePaneOptions {
  prompt: string;
  agent?: 'claude' | 'opencode' | 'codex';
  slugSuffix?: string;
  slugBase?: string;
  projectName: string;
  existingPanes: DmuxPane[];
  projectRoot?: string; // Target repository root for the new pane
  sessionConfigPath?: string; // Shared dmux config file for the current session
  sessionProjectRoot?: string; // Session root that owns sidebar/welcome pane state
}

export interface CreatePaneResult {
  pane: DmuxPane;
  needsAgentChoice: boolean;
}

async function waitForPaneReady(
  tmuxService: TmuxService,
  paneId: string,
  timeoutMs: number = 600
): Promise<void> {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (await tmuxService.paneExists(paneId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/**
 * Core pane creation logic that can be used by both TUI and API
 * Returns the newly created pane and whether agent choice is needed
 */
export async function createPane(
  options: CreatePaneOptions,
  availableAgents: Array<'claude' | 'opencode' | 'codex'>
): Promise<CreatePaneResult> {
  const {
    prompt,
    projectName,
    existingPanes,
    slugSuffix,
    slugBase,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
  } = options;
  let { agent, projectRoot: optionsProjectRoot } = options;

  // Load settings to check for default agent and autopilot
  const { SettingsManager } = await import('./settingsManager.js');

  // Get project root (handle git worktrees correctly)
  let projectRoot: string;
  if (optionsProjectRoot) {
    projectRoot = optionsProjectRoot;
  } else {
    try {
      // For git worktrees, we need to get the main repository root, not the worktree root
      // git rev-parse --git-common-dir gives us the main .git directory
      const gitCommonDir = execSync('git rev-parse --git-common-dir', {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      // If it's a worktree, gitCommonDir will be an absolute path to main .git
      // If it's the main repo, it will be just '.git'
      if (gitCommonDir === '.git') {
        // We're in the main repo
        projectRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();
      } else {
        // We're in a worktree, get the parent directory of the .git directory
        projectRoot = path.dirname(gitCommonDir);
      }
    } catch {
      projectRoot = process.cwd();
    }
  }

  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);
  const paneProjectName = path.basename(projectRoot);

  // If no agent specified, check settings for default agent
  if (!agent && settings.defaultAgent) {
    // Only use default if it's available
    if (availableAgents.includes(settings.defaultAgent)) {
      agent = settings.defaultAgent;
    }
  }

  // Determine if we need agent choice
  if (!agent && availableAgents.length > 1) {
    // Need to ask which agent to use
    return {
      pane: null as any,
      needsAgentChoice: true,
    };
  }

  // Auto-select agent if only one is available or if not specified
  if (!agent && availableAgents.length === 1) {
    agent = availableAgents[0];
  }

  // Trigger before_pane_create hook
  await triggerHook('before_pane_create', projectRoot, undefined, {
    DMUX_PROMPT: prompt,
    DMUX_AGENT: agent || 'unknown',
  });

  // Validate branchPrefix before use
  const branchPrefix = settings.branchPrefix || '';
  if (branchPrefix && !isValidBranchName(branchPrefix)) {
    throw new Error(`Invalid branch prefix: ${branchPrefix}`);
  }

  // Generate slug (filesystem-safe directory name) and branch name (may include prefix)
  const generatedSlug = slugBase || await generateSlug(prompt);
  const slug = appendSlugSuffix(generatedSlug, slugSuffix);
  const branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;
  const tmuxService = TmuxService.getInstance();

  const worktreePath = path.join(projectRoot, '.dmux', 'worktrees', slug);
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  const configPath = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.dmux', 'dmux.config.json');
  let controlPaneId: string | undefined;

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;

    // Verify the control pane ID from config still exists
    if (controlPaneId) {
      const exists = await tmuxService.paneExists(controlPaneId);
      if (!exists) {
        // Pane doesn't exist anymore, use current pane and update config
        LogService.getInstance().warn(
          `Control pane ${controlPaneId} no longer exists, updating to ${originalPaneId}`,
          'paneCreation'
        );
        controlPaneId = originalPaneId;
        config.controlPaneId = controlPaneId;
        config.controlPaneSize = SIDEBAR_WIDTH;
        config.lastUpdated = new Date().toISOString();
        atomicWriteJsonSync(configPath, config);
      }
      // Else: Pane exists, we can use it
    }

    // If control pane ID is missing, save it
    if (!controlPaneId) {
      controlPaneId = originalPaneId;
      config.controlPaneId = controlPaneId;
      config.controlPaneSize = SIDEBAR_WIDTH;
      config.lastUpdated = new Date().toISOString();

      atomicWriteJsonSync(configPath, config);
    }
  } catch (error) {
    // Fallback if config loading fails
    controlPaneId = originalPaneId;
  }

  // Enable pane borders to show titles
  try {
    tmuxService.setGlobalOptionSync('pane-border-status', 'top');
  } catch {
    // Ignore if already set or fails
  }

  // Determine if this is the first content pane
  // Check existingPanes instead of contentPaneIds, because contentPaneIds includes the welcome pane
  const isFirstContentPane = existingPanes.length === 0;

  let paneInfo: string;

  // Self-healing: Try to create pane, if it fails due to stale controlPaneId, fix and retry
  try {
    if (isFirstContentPane) {
      // First, create the tmux pane but DON'T destroy welcome pane yet
      // This way we can save the pane to config first, THEN destroy welcome pane
      paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
    } else {
      // Subsequent panes - always split horizontally, let layout manager organize
      // Get actual dmux pane IDs (not welcome pane) from existingPanes
      const dmuxPaneIds = existingPanes.map(p => p.paneId);
      const targetPane = dmuxPaneIds[dmuxPaneIds.length - 1]; // Split from the most recent dmux pane

      // Always split horizontally - the layout manager will organize panes optimally
      paneInfo = splitPane({ targetPane, cwd: projectRoot });
    }
  } catch (error) {
    // Check if error is due to stale pane ID (can't find pane)
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("can't find pane")) {
      LogService.getInstance().warn('Pane creation failed with stale control pane ID, self-healing', 'paneCreation');

      // Fix: Update controlPaneId to current pane and save to config
      const currentPaneId = originalPaneId; // We got this at the start of createPane
      LogService.getInstance().info(
        `Updating controlPaneId from ${controlPaneId} to ${currentPaneId}`,
        'paneCreation'
      );

      try {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config: DmuxConfig = JSON.parse(configContent);
        config.controlPaneId = currentPaneId;
        config.lastUpdated = new Date().toISOString();
        atomicWriteJsonSync(configPath, config);
        controlPaneId = currentPaneId; // Update local variable
      } catch (configError) {
        LogService.getInstance().error(
          `Failed to update config after control pane recovery: ${configError}`,
          'paneCreation'
        );
        throw error; // Re-throw original error
      }

      // Retry pane creation with corrected controlPaneId
      if (isFirstContentPane) {
        paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
      } else {
        const dmuxPaneIds = existingPanes.map(p => p.paneId);
        const targetPane = dmuxPaneIds[dmuxPaneIds.length - 1];
        paneInfo = splitPane({ targetPane, cwd: projectRoot });
      }
    } else {
      // Different error, re-throw
      throw error;
    }
  }

  await waitForPaneReady(tmuxService, paneInfo);

  // Set pane title (project-tagged for collision-safe rebinding across projects)
  try {
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);
  } catch {
    // Ignore if setting title fails
  }

  // Apply optimal layout using the layout manager
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];

    await recalculateAndApplyLayout(
      controlPaneId,
      allContentPaneIds,
      dimensions.width,
      dimensions.height
    );

    // Refresh tmux to apply changes
    await tmuxService.refreshClient();
  }

  // Trigger pane_created hook (after pane created, before worktree)
  await triggerHook('pane_created', projectRoot, undefined, {
    DMUX_PANE_ID: `dmux-${Date.now()}`,
    DMUX_SLUG: slug,
    DMUX_PROMPT: prompt,
    DMUX_AGENT: agent || 'unknown',
    DMUX_TMUX_PANE_ID: paneInfo,
  });

  // Check if this is a hooks editing session (before worktree creation)
  const isHooksEditingSession = !!prompt && (
    /(create|edit|modify).*(dmux|\.)?.*hooks/i.test(prompt)
    || /\.dmux-hooks/i.test(prompt)
  );

  // Create git worktree and cd into it
  try {
    // IMPORTANT: Prune stale worktrees first to avoid conflicts
    // This must run synchronously from dmux, not in the pane
    try {
      execSync('git worktree prune', {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: projectRoot,
      });
    } catch {
      // Ignore prune errors, proceed anyway
    }

    // Check if branch already exists (from a deleted worktree)
    let branchExists = false;
    try {
      execSync(`git show-ref --verify --quiet "refs/heads/${branchName}"`, {
        stdio: 'pipe',
        cwd: projectRoot,
      });
      branchExists = true;
    } catch {
      // Branch doesn't exist, which is good
    }

    // Validate and resolve base branch for new worktrees
    const baseBranch = settings.baseBranch || '';
    if (baseBranch && !isValidBranchName(baseBranch)) {
      throw new Error(`Invalid base branch name: ${baseBranch}`);
    }
    if (baseBranch) {
      try {
        execSync(`git rev-parse --verify "refs/heads/${baseBranch}"`, {
          stdio: 'pipe',
          cwd: projectRoot,
        });
      } catch {
        throw new Error(
          `Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`
        );
      }
    }

    // Build worktree command:
    // - If branch exists, use it (don't create with -b)
    // - If branch doesn't exist, create it with -b, optionally from a configured base branch
    // - DON'T silence errors (we want to see them in the pane for debugging)
    const startPoint = baseBranch ? ` "${baseBranch}"` : '';
    const worktreeAddCmd = branchExists
      ? `git worktree add "${worktreePath}" "${branchName}"`
      : `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;
    const worktreeCmd = `cd "${projectRoot}" && ${worktreeAddCmd} && cd "${worktreePath}"`;

    // Send the git worktree command (auto-quoted by sendShellCommand)
    await tmuxService.sendShellCommand(paneInfo, worktreeCmd);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

    // Wait for worktree to actually exist on the filesystem
    const maxWaitTime = 5000; // 5 seconds max
    const checkInterval = 100; // Check every 100ms
    const startTime = Date.now();

    while (!fs.existsSync(worktreePath) && (Date.now() - startTime) < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    // Verify worktree was created successfully
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree directory not created at ${worktreePath} after ${maxWaitTime}ms`);
    }

    // Give a bit more time for git to finish setting up the worktree
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Initialize .dmux-hooks if this is a hooks editing session
    if (isHooksEditingSession) {
      initializeHooksDirectory(worktreePath);
    }
  } catch (error) {
    // Worktree creation failed - send helpful error message to the pane
    const errorMsg = error instanceof Error ? error.message : String(error);
    await tmuxService.sendShellCommand(
      paneInfo,
      `echo "❌ Failed to create worktree: ${errorMsg}"`
    );
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await tmuxService.sendShellCommand(
      paneInfo,
      `echo "Tip: Try running: git worktree prune && git branch -D ${branchName}"`
    );
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, TMUX_LAYOUT_APPLY_DELAY));

    // Don't throw - let the pane stay open so user can debug
  }

  // Launch agent if specified
  if (agent) {
    await launchAgentInPane({
      paneId: paneInfo,
      agent,
      prompt,
      slug,
      projectRoot,
      permissionMode: settings.permissionMode,
    });

    // Auto-approve trust prompts for Claude (workspace trust, not edit permissions)
    if (agent === 'claude') {
      autoApproveTrustPrompt(paneInfo, prompt).catch(() => {
        // Ignore errors in background monitoring
      });
    }
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Create the pane object
  const newPane: DmuxPane = {
    id: `dmux-${Date.now()}`,
    slug,
    branchName: branchName !== slug ? branchName : undefined, // Only store if different from slug
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: paneProjectName,
    worktreePath,
    agent,
    // Set autopilot based on settings (use ?? to properly handle false vs undefined)
    autopilot: settings.enableAutopilotByDefault ?? false,
  };

  // CRITICAL: Save the pane to config IMMEDIATELY before destroying welcome pane
  // This is the event that triggers welcome pane destruction (event-based, no polling)
  if (isFirstContentPane) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: DmuxConfig = JSON.parse(configContent);

      // Add the new pane to the config (panesCount becomes 1)
      config.panes = [...existingPanes, newPane];
      config.lastUpdated = new Date().toISOString();
      atomicWriteJsonSync(configPath, config);

      // NOW destroy the welcome pane (event-based destruction)
      const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
      destroyWelcomePaneCoordinated(sessionProjectRoot);
    } catch (error) {
      // Log but don't fail - welcome pane cleanup is not critical
    }
  }

  // Trigger worktree_created hook (after full pane setup)
  await triggerHook('worktree_created', projectRoot, newPane);

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the title for the dmux pane
  try {
    await tmuxService.setPaneTitle(originalPaneId, `dmux-${projectName}`);
  } catch {
    // Ignore if setting title fails
  }

  return {
    pane: newPane,
    needsAgentChoice: false,
  };
}

/**
 * Auto-approve Claude trust prompts
 */
export async function autoApproveTrustPrompt(
  paneInfo: string,
  prompt: string
): Promise<void> {
  // Wait longer for Claude to start up before checking for prompts
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100; // 100 checks * 100ms = 10 seconds total
  const checkInterval = 100; // Check every 100ms
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
      // Capture the pane content
      const paneContent = capturePaneContent(paneInfo, 30);

      // Early exit: If Claude is already running (prompt has been processed), we're done
      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

      // Check if content has stabilized
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
          // Check if this is the new Claude numbered menu format
          const isNewClaudeFormat =
            /❯\s*1\.\s*Yes,\s*proceed/i.test(paneContent) ||
            /Enter to confirm.*Esc to exit/i.test(paneContent);

          const tmuxService = TmuxService.getInstance();
          if (isNewClaudeFormat) {
            // For new Claude format, just press Enter
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          } else {
            // Try multiple response methods for older formats
            await tmuxService.sendTmuxKeys(paneInfo, 'y');
            await new Promise((resolve) => setTimeout(resolve, 50));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
            await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          }

          promptHandled = true;

          // Wait and check if prompt is gone
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Verify the prompt is gone
          const updatedContent = capturePaneContent(paneInfo, 10);

          const promptGone = !trustPromptPatterns.some((p) =>
            p.test(updatedContent)
          );

          if (promptGone) {
            // Check if Claude is running
            const claudeRunning =
              updatedContent.includes('Claude') ||
              updatedContent.includes('claude') ||
              updatedContent.includes('Assistant') ||
              (prompt &&
                updatedContent.includes(
                  prompt.substring(0, Math.min(20, prompt.length))
                ));

            if (!claudeRunning && !updatedContent.includes('$')) {
              // Resend Claude command if needed
              await new Promise((resolve) => setTimeout(resolve, 300));
              // Note: We can't easily resend the command here without the escapedCmd
              // This is a limitation, but the TUI handles it
            }

            break;
          }
        }
      }
    } catch (error) {
      // Continue checking, errors are non-fatal
    }
  }
}
