import { describe, expect, it, vi } from 'vitest';
import { PopupManager, type PopupManagerConfig } from '../src/services/PopupManager.js';
import type { AgentName } from '../src/utils/agentLaunch.js';

function createPopupManager(availableAgents: AgentName[]): PopupManager {
  const config: PopupManagerConfig = {
    sidebarWidth: 40,
    projectRoot: '/tmp/project-root',
    popupsSupported: true,
    isDevMode: false,
    terminalWidth: 120,
    terminalHeight: 40,
    availableAgents,
    settingsManager: {
      getSettings: () => ({}),
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    projectSettings: {},
    trackProjectActivity: async (work) => await work(),
  };

  return new PopupManager(config, () => {}, () => {});
}

describe('PopupManager launchReopenWorktreePopup', () => {
  it('caps popup height and labels the selected project', async () => {
    const manager = createPopupManager(['claude', 'codex']) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: false,
      cancelled: true,
    });

    const worktrees = Array.from({ length: 20 }, (_, index) => ({
      branchName: `task-${index}`,
      lastModified: new Date(`2026-03-${String((index % 9) + 1).padStart(2, '0')}T12:00:00.000Z`),
      hasUncommittedChanges: false,
      hasWorktree: index % 3 === 0,
      hasLocalBranch: index % 2 === 0,
      hasRemoteBranch: index % 4 === 0,
      isRemote: index % 2 === 0,
    }));

    await manager.launchReopenWorktreePopup(worktrees, '/tmp/project-selected', {
      includeWorktrees: true,
      includeLocalBranches: true,
      includeRemoteBranches: false,
      remoteLoaded: false,
      filterQuery: 'task',
    }, []);

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'reopenWorktreePopup.js',
      [],
      expect.objectContaining({
        height: 25,
        title: 'Resume Branch: project-selected',
        width: 78,
      }),
      expect.objectContaining({
        projectName: 'project-selected',
        initialState: expect.objectContaining({
          includeRemoteBranches: false,
          filterQuery: 'task',
        }),
        projectRoot: '/tmp/project-selected',
        activePaneSlugs: [],
      }),
      '/tmp/project-selected'
    );
  });
});

describe('PopupManager launchSingleAgentChoicePopup', () => {
  it('uses the single-agent popup with the configured default agent', async () => {
    const manager = createPopupManager(['claude', 'codex']) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.getAvailableAgents = vi.fn(() => ['claude', 'codex']);
    manager.getSettingsManager = vi.fn(() => ({
      getSettings: () => ({
        defaultAgent: 'codex',
      }),
    }));
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: false,
      cancelled: true,
    });

    await manager.launchSingleAgentChoicePopup(
      'Select Agent',
      'Choose the agent to launch for feature/remote.',
      '/tmp/project-selected'
    );

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'singleAgentChoicePopup.js',
      [],
      expect.objectContaining({
        title: 'Select Agent',
        width: 72,
      }),
      expect.objectContaining({
        message: 'Choose the agent to launch for feature/remote.',
        options: [
          { id: 'claude', default: false },
          { id: 'codex', default: true },
        ],
      }),
      '/tmp/project-selected'
    );
  });
});
