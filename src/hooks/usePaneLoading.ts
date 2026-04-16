import fs from 'fs/promises';
import path from 'path';
import type { DmuxPane, SidebarProject } from '../types.js';
import { splitPane } from '../utils/tmux.js';
import { rebindPaneByTitle } from '../utils/paneRebinding.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { PaneLifecycleManager } from '../services/PaneLifecycleManager.js';
import { TMUX_COMMAND_TIMEOUT, TMUX_RETRY_DELAY } from '../constants/timing.js';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import { buildAgentResumeOrLaunchCommand } from '../utils/agentLaunch.js';
import { ensureGeminiFolderTrusted } from '../utils/geminiTrust.js';
import { getPaneTmuxTitle } from '../utils/paneTitle.js';
import {
  getVisiblePanes,
  syncHiddenStateFromCurrentWindow,
} from '../utils/paneVisibility.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';

// Separate config structure to match new format
export interface DmuxConfig {
  projectName?: string;
  projectRoot?: string;
  panes: DmuxPane[];
  sidebarProjects?: SidebarProject[];
  settings?: any;
  lastUpdated?: string;
  controlPaneId?: string;
  welcomePaneId?: string;
}

interface PaneLoadResult {
  panes: DmuxPane[];
  allPaneIds: string[];
  titleToId: Map<string, string>;
}

async function restoreAgentSessionForPane(
  tmuxService: TmuxService,
  pane: DmuxPane,
  paneId: string
): Promise<void> {
  if (!pane.agent) {
    return;
  }

  if (pane.agent === 'gemini' && pane.worktreePath) {
    ensureGeminiFolderTrusted(pane.worktreePath);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  await tmuxService.sendShellCommand(
    paneId,
    buildAgentResumeOrLaunchCommand(pane.agent, pane.permissionMode)
  );
  await tmuxService.sendTmuxKeys(paneId, 'Enter');
}

/**
 * Fetches all tmux pane IDs and titles for the current session
 * Retries up to maxRetries times with delay between attempts
 */
export async function fetchTmuxPaneIds(maxRetries = 2): Promise<{
  allPaneIds: string[];
  titleToId: Map<string, string>;
  currentWindowPaneIds: string[];
}> {
  const tmuxService = TmuxService.getInstance();
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const paneInfo = await tmuxService.getAllPaneInfo('session');
      const currentWindowPaneIds = await tmuxService.getAllPaneIds('window');
      const allPaneIds: string[] = [];
      const titleToId = new Map<string, string>();

      for (const pane of paneInfo) {
        if (!pane.paneId || !pane.paneId.startsWith('%') || pane.title === 'dmux-spacer') {
          continue;
        }
        allPaneIds.push(pane.paneId);
        if (pane.title) {
          titleToId.set(pane.title.trim(), pane.paneId);
        }
      }

      if (allPaneIds.length > 0 || retryCount === maxRetries) {
        return { allPaneIds, titleToId, currentWindowPaneIds };
      }
    } catch (error) {
      // Retry on tmux command failure (common during rapid pane creation/destruction)
  //       LogService.getInstance().debug(
  //         `Tmux fetch failed (attempt ${retryCount + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`,
  //         'usePaneLoading'
  //       );
      if (retryCount < maxRetries) await new Promise(r => setTimeout(r, TMUX_RETRY_DELAY));
    }
    retryCount++;
  }

  return { allPaneIds: [], titleToId: new Map(), currentWindowPaneIds: [] };
}

/**
 * Reads and parses the panes config file
 * Handles both old array format and new config format
 */
export async function loadPanesFromFile(panesFile: string): Promise<DmuxPane[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return syncPaneColorThemes(parsed as DmuxPane[], [], fallbackProjectRoot);
    } else {
      const config = parsed as DmuxConfig;
      const projectRoot = config.projectRoot || fallbackProjectRoot;
      const panes = Array.isArray(config.panes) ? config.panes : [];
      const sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
      return syncPaneColorThemes(panes, sidebarProjects, projectRoot);
    }
  } catch (error) {
    // Return empty array if config file doesn't exist or is invalid
    // This is expected on first run
  //     LogService.getInstance().debug(
  //       `Config file not found or invalid: ${error instanceof Error ? error.message : String(error)}`,
  //       'usePaneLoading'
  //     );
    return [];
  }
}

export async function loadSidebarProjectsFromFile(
  panesFile: string,
  panes?: DmuxPane[]
): Promise<SidebarProject[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);
    const config = Array.isArray(parsed)
      ? { panes: parsed as DmuxPane[] }
      : parsed as DmuxConfig;
    const configPanes = Array.isArray(config.panes) ? config.panes : [];
    const effectivePanes = panes || configPanes;
    const projectRoot = config.projectRoot || fallbackProjectRoot;
    const projectName = config.projectName || path.basename(projectRoot);

    return normalizeSidebarProjects(
      config.sidebarProjects,
      effectivePanes,
      projectRoot,
      projectName
    );
  } catch {
    return normalizeSidebarProjects(
      undefined,
      panes || [],
      fallbackProjectRoot,
      path.basename(fallbackProjectRoot)
    );
  }
}

/**
 * Recreates missing worktree panes that exist in config but not in tmux
 * Only called on initial load
 */
export async function recreateMissingPanes(
  missingPanes: DmuxPane[],
  panesFile: string
): Promise<void> {
  if (missingPanes.length === 0) return;

  const tmuxService = TmuxService.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  for (const missingPane of missingPanes) {
    try {
      // Create new pane
      const newPaneId = splitPane({ cwd: missingPane.worktreePath || process.cwd() });

      // Set pane title
      await tmuxService.setPaneTitle(newPaneId, getPaneTmuxTitle(missingPane, sessionProjectRoot));

      // Update the pane with new ID
      missingPane.paneId = newPaneId;

      // Send a message to the pane indicating it was restored
      await tmuxService.sendKeys(newPaneId, `"echo '# Pane restored: ${missingPane.slug}'" Enter`);
      const promptPreview = missingPane.prompt?.substring(0, 50) || '';
      await tmuxService.sendKeys(newPaneId, `"echo '# Original prompt: ${promptPreview}...'" Enter`);
      await tmuxService.sendKeys(newPaneId, `"cd ${missingPane.worktreePath || process.cwd()}" Enter`);
      await restoreAgentSessionForPane(tmuxService, missingPane, newPaneId);
    } catch (error) {
      // If we can't create the pane, skip it
    }
  }

  // Apply even-horizontal layout after creating panes
  try {
    await tmuxService.selectLayout('even-horizontal');
    await tmuxService.refreshClient();
  } catch {}
}

/**
 * Recreates worktree panes that were killed by the user (e.g., via Ctrl+b x)
 * Called during periodic polling after initial load
 *
 * IMPORTANT: Checks PaneLifecycleManager to avoid recreating panes that are
 * being intentionally closed (prevents race condition with close/merge actions)
 */
export async function recreateKilledWorktreePanes(
  panes: DmuxPane[],
  allPaneIds: string[],
  panesFile: string
): Promise<DmuxPane[]> {
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  // Filter out panes that are being intentionally closed
  const worktreePanesToRecreate = panes.filter(pane => {
    // Pane must be missing from tmux and have a worktree path
    if (allPaneIds.includes(pane.paneId) || !pane.worktreePath) {
      return false;
    }

    // CRITICAL: Check if this pane is being intentionally closed
    // This is a safety belt - the main protection is that close action
    // removes pane from config BEFORE killing tmux pane
    if (lifecycleManager.isClosing(pane.id) || lifecycleManager.isClosing(pane.paneId)) {
      LogService.getInstance().debug(
        `Skipping recreation of pane ${pane.id} (${pane.slug}) - intentionally being closed`,
        'shellDetection'
      );
      return false;
    }

    return true;
  });

  if (worktreePanesToRecreate.length === 0) return panes;

  const tmuxService = TmuxService.getInstance();

  //   LogService.getInstance().debug(
  //     `Recreating ${worktreePanesToRecreate.length} killed worktree panes`,
  //     'shellDetection'
  //   );

  const updatedPanes = [...panes];

  for (const pane of worktreePanesToRecreate) {
    try {
      // Create new pane in the worktree directory
      const newPaneId = splitPane({ cwd: pane.worktreePath });

      // Set pane title
      await tmuxService.setPaneTitle(newPaneId, getPaneTmuxTitle(pane, sessionProjectRoot));

      // Update the pane with new ID
      const paneIndex = updatedPanes.findIndex(p => p.id === pane.id);
      if (paneIndex !== -1) {
        updatedPanes[paneIndex] = { ...pane, paneId: newPaneId };
      }

      // Send a message to the pane indicating it was restored
      await tmuxService.sendKeys(newPaneId, `"echo '# Pane restored: ${pane.slug}'" Enter`);
      if (pane.prompt) {
        const promptPreview = pane.prompt.substring(0, 50) || '';
        await tmuxService.sendKeys(newPaneId, `"echo '# Original prompt: ${promptPreview}...'" Enter`);
      }
      await tmuxService.sendKeys(newPaneId, `"cd ${pane.worktreePath}" Enter`);
      await restoreAgentSessionForPane(tmuxService, pane, newPaneId);

  //       LogService.getInstance().debug(
  //         `Recreated worktree pane ${pane.id} (${pane.slug}) with new ID ${newPaneId}`,
  //         'shellDetection'
  //       );
    } catch (error) {
  //       LogService.getInstance().debug(
  //         `Failed to recreate worktree pane ${pane.id} (${pane.slug})`,
  //         'shellDetection'
  //       );
    }
  }

  // Recalculate layout after recreating panes
  try {
    const configContent = await fs.readFile(panesFile, 'utf-8');
    const config = JSON.parse(configContent);
    if (config.controlPaneId) {
      const { recalculateAndApplyLayout } = await import('../utils/layoutManager.js');
      const { getTerminalDimensions } = await import('../utils/tmux.js');
      const dimensions = getTerminalDimensions();

      const contentPaneIds = getVisiblePanes(updatedPanes).map(p => p.paneId);
      recalculateAndApplyLayout(
        config.controlPaneId,
        contentPaneIds,
        dimensions.width,
        dimensions.height
      );

  //       LogService.getInstance().debug(
  //         `Recalculated layout after recreating worktree panes`,
  //         'shellDetection'
  //       );
    }
  } catch (error) {
  //     LogService.getInstance().debug(
  //       'Failed to recalculate layout after recreating worktree panes',
  //       'shellDetection'
  //     );
  }

  return updatedPanes;
}

/**
 * Loads panes from config file, rebinds IDs, and recreates missing panes
 * Returns the loaded and processed panes along with tmux state
 *
 * CRITICAL FIX: On initial load, stale shell panes are removed immediately.
 * Shell panes have no worktreePath so they cannot be recreated - keeping them
 * with stale paneIds causes dmux to hang when trying to interact with them.
 */
export async function loadAndProcessPanes(
  panesFile: string,
  isInitialLoad: boolean
): Promise<PaneLoadResult> {
  const loadedPanes = await loadPanesFromFile(panesFile);
  let { allPaneIds, titleToId, currentWindowPaneIds } = await fetchTmuxPaneIds();

  // Attempt to rebind panes whose IDs changed by matching on their stable tmux title.
  let reboundPanes = syncHiddenStateFromCurrentWindow(
    loadedPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
    currentWindowPaneIds
  );

  // CRITICAL FIX: On initial load, immediately filter out shell panes with stale IDs
  // Shell panes cannot be recreated (no worktreePath), so keeping them causes:
  // 1. Hang when trying to send keys to non-existent panes
  // 2. Hang when trying to get pane status/content
  // 3. "Invalid layout" errors when applying layouts with stale pane IDs
  if (isInitialLoad && allPaneIds.length > 0) {
    const staleShellPanes = reboundPanes.filter(
      p => p.type === 'shell' && !allPaneIds.includes(p.paneId)
    );

    if (staleShellPanes.length > 0) {
      LogService.getInstance().info(
        `Removing ${staleShellPanes.length} stale shell pane(s) on startup: ${staleShellPanes.map(p => p.slug).join(', ')}`,
        'usePaneLoading'
      );
      reboundPanes = reboundPanes.filter(
        p => !(p.type === 'shell' && !allPaneIds.includes(p.paneId))
      );

      // Save the cleaned config immediately to prevent these panes from reappearing
      try {
        const fs = await import('fs/promises');
        const configContent = await fs.readFile(panesFile, 'utf-8');
        const config = JSON.parse(configContent);
        config.panes = reboundPanes;
        const projectRoot = config.projectRoot || path.dirname(path.dirname(panesFile));
        const projectName = config.projectName || path.basename(projectRoot);
        config.sidebarProjects = normalizeSidebarProjects(
          config.sidebarProjects,
          reboundPanes,
          projectRoot,
          projectName
        );
        config.lastUpdated = new Date().toISOString();
        await atomicWriteJson(panesFile, config);
        LogService.getInstance().debug('Saved cleaned config after removing stale shell panes', 'usePaneLoading');
      } catch (saveError) {
        LogService.getInstance().debug(
          `Failed to save cleaned config: ${saveError}`,
          'usePaneLoading'
        );
      }
    }
  }

  // Only attempt to recreate missing panes on initial load (only worktree panes, not shell)
  const missingPanes = (allPaneIds.length > 0 && reboundPanes.length > 0 && isInitialLoad)
    ? reboundPanes.filter(pane =>
        !allPaneIds.includes(pane.paneId) && pane.type !== 'shell'
      )
    : [];

  // Recreate missing panes (only on initial load)
  await recreateMissingPanes(missingPanes, panesFile);

  // Re-fetch pane IDs after recreation
  if (missingPanes.length > 0) {
    const freshData = await fetchTmuxPaneIds();
    allPaneIds = freshData.allPaneIds;
    titleToId = freshData.titleToId;
    currentWindowPaneIds = freshData.currentWindowPaneIds;

    // Re-rebind after recreation
    reboundPanes = syncHiddenStateFromCurrentWindow(
      reboundPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
      currentWindowPaneIds
    );
  }

  return { panes: reboundPanes, allPaneIds, titleToId };
}
