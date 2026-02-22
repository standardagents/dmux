/**
 * Attach a second (or Nth) agent to an existing worktree pane.
 *
 * Creates a new tmux pane that `cd`s into the same worktree directory,
 * launches the chosen agent, and returns a sibling DmuxPane that shares
 * the same worktreePath/branchName/projectRoot.
 */

import * as fs from 'fs';
import path from 'path';
import type { DmuxPane, DmuxConfig } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { launchAgentInPane } from './agentLaunch.js';
import { autoApproveTrustPrompt } from './paneCreation.js';
import { TmuxService } from '../services/TmuxService.js';
import { splitPane, getTerminalDimensions } from './tmux.js';
import { recalculateAndApplyLayout } from './layoutManager.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { SettingsManager } from './settingsManager.js';
import { LogService } from '../services/LogService.js';

export interface AttachAgentOptions {
  targetPane: DmuxPane;
  prompt: string;
  agent: AgentName;
  existingPanes: DmuxPane[];
  sessionProjectRoot: string;
  sessionConfigPath: string;
}

/**
 * Generate a unique sibling slug like `fix-auth-a2`, `fix-auth-a3`, etc.
 */
function generateSiblingSlug(baseSlug: string, existingPanes: DmuxPane[]): string {
  const existingSlugs = new Set(existingPanes.map(p => p.slug));
  let n = 2;
  while (existingSlugs.has(`${baseSlug}-a${n}`)) {
    n++;
  }
  return `${baseSlug}-a${n}`;
}

export async function attachAgentToWorktree(
  options: AttachAgentOptions
): Promise<{ pane: DmuxPane }> {
  const {
    targetPane,
    prompt,
    agent,
    existingPanes,
    sessionProjectRoot,
    sessionConfigPath,
  } = options;

  if (!targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }

  const projectRoot = targetPane.projectRoot || sessionProjectRoot;
  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  // Generate a unique slug for this sibling
  const slug = generateSiblingSlug(targetPane.slug, existingPanes);

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  let controlPaneId: string | undefined;
  try {
    const configContent = fs.readFileSync(sessionConfigPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;
  } catch {
    controlPaneId = originalPaneId;
  }

  // Split from the last existing pane (standard grid placement)
  const dmuxPaneIds = existingPanes.map(p => p.paneId);
  const splitTarget = dmuxPaneIds[dmuxPaneIds.length - 1];
  const paneInfo = splitPane({ targetPane: splitTarget, cwd: projectRoot });

  // Wait for pane to be ready
  const start = Date.now();
  while ((Date.now() - start) < 600) {
    if (await tmuxService.paneExists(paneInfo)) break;
    await new Promise(r => setTimeout(r, 30));
  }

  // Set pane title
  try {
    const paneProjectName = targetPane.projectName || path.basename(projectRoot);
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);
  } catch {
    // Ignore title errors
  }

  // Recalculate layout
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];
    await recalculateAndApplyLayout(
      controlPaneId,
      allContentPaneIds,
      dimensions.width,
      dimensions.height,
    );
    await tmuxService.refreshClient();
  }

  // cd into the existing worktree (no git worktree add)
  const cdCmd = `cd "${targetPane.worktreePath}"`;
  await tmuxService.sendShellCommand(paneInfo, cdCmd);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

  // Small delay for cd to complete
  await new Promise(r => setTimeout(r, 300));

  // Launch the agent
  await launchAgentInPane({
    paneId: paneInfo,
    agent,
    prompt,
    slug,
    projectRoot,
    permissionMode: settings.permissionMode,
  });

  // Auto-approve trust prompts for Claude
  if (agent === 'claude') {
    autoApproveTrustPrompt(paneInfo, prompt).catch(() => {
      // Ignore errors in background monitoring
    });
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Build the sibling pane object — shares worktree/branch with target
  const newPane: DmuxPane = {
    id: `dmux-${Date.now()}`,
    slug,
    branchName: targetPane.branchName,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: targetPane.projectName,
    worktreePath: targetPane.worktreePath,
    agent,
    autopilot: settings.enableAutopilotByDefault ?? false,
  };

  // Switch focus back to control pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the dmux sidebar title
  try {
    const sessionProjectName = path.basename(sessionProjectRoot);
    await tmuxService.setPaneTitle(originalPaneId, `dmux-${sessionProjectName}`);
  } catch {
    // Ignore title errors
  }

  LogService.getInstance().info(
    `Attached ${agent} to worktree ${targetPane.worktreePath} as ${slug}`,
    'attachAgent',
  );

  return { pane: newPane };
}
