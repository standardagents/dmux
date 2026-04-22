import path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { DmuxPane, DmuxConfig, MergeTargetReference } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import { SIDEBAR_WIDTH, recalculateAndApplyLayout } from './layoutManager.js';
import { generateSlug } from './slug.js';
import { capturePaneContent } from './paneCapture.js';
import { triggerHook } from './hooks.js';
import { TMUX_SPLIT_DELAY } from '../constants/timing.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { LogService } from '../services/LogService.js';
import type { AgentName } from './agentLaunch.js';
import { getPaneTmuxTitle } from './paneTitle.js';
import { shellQuote } from './promptStore.js';
import { isValidBranchName, isValidFullBranchName } from './git.js';
import { resolvePaneNaming } from './paneNaming.js';
import { readWorktreeMetadata } from './worktreeMetadata.js';
import { resolveProjectColorTheme } from './paneColors.js';
import type { SidebarProject } from '../types.js';
import { StateManager } from '../shared/StateManager.js';
import {
  DMUX_BOOTSTRAP_PANE_TITLE_PREFIX,
  type PaneBootstrapConfig,
} from './paneBootstrapConfig.js';

export interface CreatePaneOptions {
  prompt: string;
  agent?: AgentName;
  slugSuffix?: string;
  slugBase?: string;
  baseBranchOverride?: string;
  branchNameOverride?: string;
  existingWorktree?: {
    slug: string;
    worktreePath: string;
    branchName: string;
  };
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  projectName: string;
  existingPanes: DmuxPane[];
  projectRoot?: string; // Target repository root for the new pane
  skipAgentSelection?: boolean; // Explicitly allow creating pane with no agent
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

function getCurrentWindowPaneIds(tmuxService: TmuxService): string[] {
  try {
    return tmuxService.getAllPaneIdsSync();
  } catch {
    return [];
  }
}

function getVisibleExistingPaneIds(
  existingPanes: DmuxPane[],
  currentWindowPaneIds: string[]
): string[] {
  return existingPanes
    .filter((pane) => {
      if (currentWindowPaneIds.length > 0) {
        return currentWindowPaneIds.includes(pane.paneId);
      }

      return !pane.hidden;
    })
    .map((pane) => pane.paneId);
}

function getPaneSplitTarget(
  existingPanes: DmuxPane[],
  currentWindowPaneIds: string[],
  controlPaneId: string | undefined
): string | undefined {
  const visibleExistingPaneIds = getVisibleExistingPaneIds(
    existingPanes,
    currentWindowPaneIds
  );
  return visibleExistingPaneIds[visibleExistingPaneIds.length - 1] || controlPaneId;
}

function resolvePaneBootstrapRunnerPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const utilsDir = path.dirname(currentFile);
  const compiledRunner = path.join(utilsDir, 'paneBootstrapRunner.js');
  if (fs.existsSync(compiledRunner)) {
    return compiledRunner;
  }

  return path.join(utilsDir, 'paneBootstrapRunner.ts');
}

function writePaneBootstrapConfig(
  projectRoot: string,
  slug: string,
  config: PaneBootstrapConfig
): string {
  const bootstrapDir = path.join(projectRoot, '.dmux', 'bootstrap');
  fs.mkdirSync(bootstrapDir, { recursive: true });
  const configPath = path.join(
    bootstrapDir,
    `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

function buildPaneBootstrapCommand(
  runnerPath: string,
  configPath: string,
  worktreePath: string
): string {
  const statusVar = '__dmux_bootstrap_status';
  return [
    `${shellQuote(process.execPath)} ${shellQuote(runnerPath)} ${shellQuote(configPath)}`,
    `${statusVar}=$?`,
    `if [ -d ${shellQuote(worktreePath)} ]; then cd ${shellQuote(worktreePath)}; fi`,
    `test $${statusVar} -eq 0 || true`,
  ].join('; ');
}

/**
 * Core pane creation logic that can be used by both TUI and API
 * Returns the newly created pane and whether agent choice is needed
 */
export async function createPane(
  options: CreatePaneOptions,
  availableAgents: AgentName[]
): Promise<CreatePaneResult> {
  const {
    prompt,
    projectName,
    existingPanes,
    slugSuffix,
    slugBase,
    baseBranchOverride,
    branchNameOverride,
    existingWorktree,
    startPointBranch,
    mergeTargetChain,
    skipAgentSelection = false,
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
  const existingWorktreeMetadata = existingWorktree
    ? readWorktreeMetadata(existingWorktree.worktreePath)
    : null;

  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);
  const paneProjectName = path.basename(projectRoot);

  // If no agent specified, check settings for default agent unless caller explicitly disabled auto-selection.
  if (!agent && !skipAgentSelection && settings.defaultAgent) {
    // Only use default if it's available
    if (availableAgents.includes(settings.defaultAgent)) {
      agent = settings.defaultAgent;
    }
  }

  // Determine if we need agent choice
  if (!agent && !skipAgentSelection && availableAgents.length > 1) {
    // Need to ask which agent to use
    return {
      pane: null as any,
      needsAgentChoice: true,
    };
  }

  // Auto-select agent if only one is available or if not specified
  if (!agent && !skipAgentSelection && availableAgents.length === 1) {
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

  const overrideBranchName = (branchNameOverride || '').trim();
  if (overrideBranchName && !isValidFullBranchName(overrideBranchName)) {
    throw new Error(`Invalid branch name override: ${overrideBranchName}`);
  }

  const overrideBaseBranch = (baseBranchOverride || '').trim();
  if (overrideBaseBranch && !isValidFullBranchName(overrideBaseBranch)) {
    throw new Error(`Invalid base branch override: ${overrideBaseBranch}`);
  }

  // Generate slug/worktree + branch names.
  // Explicit branch name override takes precedence over branchPrefix.
  const generatedSlug = existingWorktree
    ? existingWorktree.slug
    : (slugBase || await generateSlug(prompt));
  const naming = resolvePaneNaming({
    generatedSlug,
    slugSuffix,
    branchPrefix,
    baseBranchSetting: settings.baseBranch,
    baseBranchOverride: overrideBaseBranch,
    branchNameOverride: overrideBranchName,
  });
  const slug = existingWorktree ? existingWorktree.slug : naming.slug;
  const branchName = existingWorktree ? existingWorktree.branchName : naming.branchName;
  const effectiveBaseBranch = naming.baseBranch;
  const tmuxService = TmuxService.getInstance();

  const worktreePath = existingWorktree?.worktreePath
    || path.join(projectRoot, '.dmux', 'worktrees', slug);
  if (!existingWorktree && fs.existsSync(worktreePath)) {
    throw new Error(
      `Worktree path already exists: ${worktreePath}. Choose a different branch/worktree name.`
    );
  }
  const originalPaneId = tmuxService.getCurrentPaneIdSync();
  let currentWindowPaneIds = getCurrentWindowPaneIds(tmuxService);

  // Load config to get control pane info
  const configPath = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.dmux', 'dmux.config.json');
  let controlPaneId: string | undefined;
  let configSidebarProjects: SidebarProject[] = [];

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;
    configSidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];

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
    ensurePaneBorderStatusForCurrentSession();
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
      // Split from a pane in the active dmux window. Hidden panes live in
      // detached tmux windows, so targeting them would create a hidden pane.
      const targetPane = getPaneSplitTarget(
        existingPanes,
        currentWindowPaneIds,
        controlPaneId
      );
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
        currentWindowPaneIds = getCurrentWindowPaneIds(tmuxService);
        const targetPane = getPaneSplitTarget(
          existingPanes,
          currentWindowPaneIds,
          controlPaneId
        );
        paneInfo = splitPane({ targetPane, cwd: projectRoot });
      }
    } else {
      // Different error, re-throw
      throw error;
    }
  }

  await waitForPaneReady(tmuxService, paneInfo);

  // Mark the pane as dmux-owned immediately. Without this, the shell-pane
  // detector can race the config save and classify a still-bootstrapping
  // worktree pane as a user-created shell pane.
  try {
    await tmuxService.setPaneTitle(
      paneInfo,
      `${DMUX_BOOTSTRAP_PANE_TITLE_PREFIX}${slug}`
    );
  } catch {
    // Ignore if setting title fails
  }

  // Apply optimal layout using the layout manager
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const visibleContentPaneIds = getVisibleExistingPaneIds(existingPanes, currentWindowPaneIds);
    const allContentPaneIds = [...visibleContentPaneIds, paneInfo];

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

  // Validate branch settings before handing the slow setup work to the pane.
  const resolvedStartPoint = startPointBranch || effectiveBaseBranch || undefined;
  if (resolvedStartPoint && !isValidBranchName(resolvedStartPoint)) {
    throw new Error(`Invalid worktree start-point branch name: ${resolvedStartPoint}`);
  }

  const newPane: DmuxPane = {
    id: `dmux-${Date.now()}`,
    slug,
    displayName: existingWorktreeMetadata?.displayName,
    branchName: branchName !== slug ? branchName : undefined,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: paneProjectName,
    colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
    worktreePath,
    agent,
    hidden: false,
    permissionMode: settings.permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
    mergeTargetChain,
  };

  const state = StateManager.getInstance().getState();
  const tmuxTitle = getPaneTmuxTitle(newPane, sessionProjectRoot);
  const hookExtraEnv = state.serverPort
    ? { DMUX_SERVER_PORT: String(state.serverPort) }
    : undefined;
  const bootstrapConfig: PaneBootstrapConfig = {
    version: 1,
    projectRoot,
    worktreePath,
    branchName,
    slug,
    prompt,
    agent,
    permissionMode: settings.permissionMode,
    pane: newPane,
    tmuxTitle,
    existingWorktree: !!existingWorktree,
    resolvedStartPoint,
    isHooksEditingSession,
    metadata: {
      agent,
      permissionMode: settings.permissionMode,
      displayName: existingWorktreeMetadata?.displayName,
      branchName: branchName !== slug ? branchName : undefined,
      mergeTargetChain,
    },
    hookExtraEnv,
  };

  try {
    const bootstrapConfigPath = writePaneBootstrapConfig(projectRoot, slug, bootstrapConfig);
    const bootstrapCommand = buildPaneBootstrapCommand(
      resolvePaneBootstrapRunnerPath(),
      bootstrapConfigPath,
      worktreePath
    );
    await tmuxService.sendShellCommand(paneInfo, bootstrapCommand);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    LogService.getInstance().error(
      `Failed to start pane bootstrap for ${slug}: ${errorMsg}`,
      'paneCreation',
      undefined,
      error instanceof Error ? error : undefined
    );
    try {
      await tmuxService.killPane(paneInfo);
    } catch {
      // best-effort cleanup
    }
    throw new Error(`Failed to start pane bootstrap for "${slug}": ${errorMsg}`);
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // CRITICAL: Save the pane to config IMMEDIATELY before destroying welcome pane.
  // Only needed for the first content pane — ensures loadPanes sees a pane in config
  // before we kill the welcome pane (prevents spurious "0 panes" welcome recreation).
  if (isFirstContentPane) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config: DmuxConfig = JSON.parse(configContent);

      // Add the new pane to the config (panesCount becomes 1)
      config.panes = [...existingPanes, newPane];
      config.lastUpdated = new Date().toISOString();
      atomicWriteJsonSync(configPath, config);
    } catch (error) {
      // Log but don't fail - welcome pane cleanup is not critical
    }
  }

  // Always destroy the welcome pane if one exists in config.
  // We do this unconditionally because shell panes detected by detectAndAddShellPanes
  // can make existingPanes.length > 0 even when no real content panes exist yet,
  // which causes isFirstContentPane to be false and skips welcome pane destruction.
  try {
    const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    destroyWelcomePaneCoordinated(sessionProjectRoot);
  } catch {
    // Ignore - welcome pane cleanup is not critical
  }

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the title for the dmux pane
  try {
    await tmuxService.setPaneTitle(originalPaneId, "dmux");
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
