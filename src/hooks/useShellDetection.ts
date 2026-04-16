import fs from 'fs/promises';
import path from 'path';
import type { DmuxPane } from '../types.js';
import { getUntrackedPanes, createShellPane, getNextDmuxId } from '../utils/shellPaneDetection.js';
import { LogService } from '../services/LogService.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';

/**
 * Detects untracked panes (manually created via tmux commands)
 * and creates shell pane objects for them
 */
export async function detectAndAddShellPanes(
  panesFile: string,
  activePanes: DmuxPane[],
  allPaneIds: string[]
): Promise<{ updatedPanes: DmuxPane[]; shellPanesAdded: boolean }> {
  // Only detect if we have pane IDs from tmux
  if (allPaneIds.length === 0) {
    return { updatedPanes: activePanes, shellPanesAdded: false };
  }

  try {
    // Get controlPaneId and welcomePaneId from config
    let controlPaneId: string | undefined;
    let welcomePaneId: string | undefined;
    let projectRoot = path.dirname(path.dirname(panesFile));
    let sidebarProjects: import('../types.js').SidebarProject[] = [];

    try {
      const configContent = await fs.readFile(panesFile, 'utf-8');
      const config = JSON.parse(configContent);
      controlPaneId = config.controlPaneId;
      welcomePaneId = config.welcomePaneId;
      projectRoot = config.projectRoot || projectRoot;
      sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
    } catch (error) {
      // Config not available (expected on first run), continue without filtering
  //       LogService.getInstance().debug(
  //         `Config file not available for shell detection: ${error instanceof Error ? error.message : String(error)}`,
  //         'useShellDetection'
  //       );
    }

    const trackedPaneIds = activePanes.map(p => p.paneId);
  //     LogService.getInstance().debug(
  //       `Checking for untracked panes. Tracked: [${trackedPaneIds.join(', ')}], Control: ${controlPaneId}, Welcome: ${welcomePaneId}`,
  //       'shellDetection'
  //     );

    const sessionName = ''; // Empty string will make tmux use current session
    const untrackedPanes = await getUntrackedPanes(sessionName, trackedPaneIds, controlPaneId, welcomePaneId);

    if (untrackedPanes.length === 0) {
      return { updatedPanes: activePanes, shellPanesAdded: false };
    }

  //     LogService.getInstance().debug(
  //       `Found ${untrackedPanes.length} untracked panes: ${untrackedPanes.map(p => p.paneId).join(', ')}`,
  //       'shellDetection'
  //     );

    // Create shell pane objects for each untracked pane
    const newShellPanes: DmuxPane[] = [];
    let nextId = getNextDmuxId(activePanes);

    for (const paneInfo of untrackedPanes) {
      const shellPane = await createShellPane(paneInfo.paneId, nextId, paneInfo.title);
      newShellPanes.push(
        syncPaneColorThemes([shellPane], sidebarProjects, projectRoot)[0]
      );
      nextId++;
    }

    // Add new shell panes to active panes
    const updatedPanes = [...activePanes, ...newShellPanes];

  //     LogService.getInstance().debug(
  //       `Added ${newShellPanes.length} shell panes to tracking`,
  //       'shellDetection'
  //     );

    return { updatedPanes, shellPanesAdded: true };
  } catch (error) {
  //     LogService.getInstance().debug(
  //       'Failed to detect untracked panes',
  //       'shellDetection'
  //     );
    return { updatedPanes: activePanes, shellPanesAdded: false };
  }
}
