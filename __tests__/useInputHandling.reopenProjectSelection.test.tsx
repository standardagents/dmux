import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useInputHandling } from '../src/hooks/useInputHandling.js';
import type { ProjectActionItem } from '../src/utils/projectActions.js';
import { getResumableBranches } from '../src/utils/resumeBranches.js';
import {
  createEmptyGitProject,
  inspectProjectCreationTarget,
  resolveProjectRootFromPath,
} from '../src/utils/projectRoot.js';

vi.mock('../src/utils/resumeBranches.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/resumeBranches.js')>('../src/utils/resumeBranches.js');
  return {
    ...actual,
    getResumableBranches: vi.fn(),
  };
});

vi.mock('../src/utils/projectRoot.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/projectRoot.js')>('../src/utils/projectRoot.js');
  return {
    ...actual,
    createEmptyGitProject: vi.fn(actual.createEmptyGitProject),
    inspectProjectCreationTarget: vi.fn(actual.inspectProjectCreationTarget),
    resolveProjectRootFromPath: vi.fn(actual.resolveProjectRootFromPath),
  };
});

vi.mock('../src/utils/settingsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/settingsManager.js')>('../src/utils/settingsManager.js');
  return {
    ...actual,
    SettingsManager: vi.fn(() => ({
      getSettings: vi.fn(() => ({ colorTheme: 'orange' })),
    })),
  };
});

vi.mock('../src/utils/remotePaneActions.js', () => ({
  drainRemotePaneActions: vi.fn(async () => []),
  getCurrentTmuxSessionName: vi.fn(() => null),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Harness({
  selectedIndex,
  projectActionItems,
  popupManager,
  activeProjectRoot = '/repo-root',
  trackProjectActivity = vi.fn(async (work: () => unknown) => await work()),
  handleReopenWorktree = vi.fn(),
  setStatusMessage = vi.fn(),
  saveSidebarProjects = vi.fn(async (projects) => projects),
}: {
  selectedIndex: number;
  projectActionItems: ProjectActionItem[];
  popupManager: any;
  activeProjectRoot?: string;
  trackProjectActivity?: any;
  handleReopenWorktree?: any;
  setStatusMessage?: ReturnType<typeof vi.fn>;
  saveSidebarProjects?: ReturnType<typeof vi.fn>;
}) {
  useInputHandling({
    panes: [],
    selectedIndex,
    setSelectedIndex: vi.fn(),
    isCreatingPane: false,
    setIsCreatingPane: vi.fn(),
    runningCommand: false,
    isUpdating: false,
    isLoading: false,
    ignoreInput: false,
    isDevMode: false,
    quitConfirmMode: false,
    setQuitConfirmMode: vi.fn(),
    showCommandPrompt: null,
    setShowCommandPrompt: vi.fn(),
    commandInput: '',
    setCommandInput: vi.fn(),
    showFileCopyPrompt: false,
    setShowFileCopyPrompt: vi.fn(),
    currentCommandType: null,
    setCurrentCommandType: vi.fn(),
    projectSettings: {},
    saveSettings: vi.fn(),
    settingsManager: {},
    popupManager,
    actionSystem: {
      actionState: {},
      executeAction: vi.fn(),
      executeCallback: vi.fn(),
      clearDialog: vi.fn(),
      clearStatus: vi.fn(),
      setActionState: vi.fn(),
    },
    controlPaneId: undefined,
    trackProjectActivity,
    setStatusMessage,
    copyNonGitFiles: vi.fn(),
    runCommandInternal: vi.fn(),
    handlePaneCreationWithAgent: vi.fn(),
    handleCreateChildWorktree: vi.fn(),
    handleReopenWorktree,
    setDevSourceFromPane: vi.fn(),
    savePanes: vi.fn(),
    sidebarProjects: [
      { projectRoot: '/repo-root', projectName: 'repo-root' },
      { projectRoot: '/repo-selected', projectName: 'repo-selected' },
    ],
    saveSidebarProjects,
    loadPanes: vi.fn(),
    cleanExit: vi.fn(),
    getAvailableAgentsForProject: vi.fn(() => []),
    panesFile: '/tmp/dmux.config.json',
    projectRoot: '/repo-root',
    activeProjectRoot,
    projectActionItems,
    findCardInDirection: vi.fn(() => null),
  });

  return <Text>dmux</Text>;
}

describe('useInputHandling reopen project selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts to create a new project when the selected path does not exist', async () => {
    vi.mocked(resolveProjectRootFromPath).mockImplementation(() => {
      throw new Error('Path does not exist: /repo-root/new-project');
    });
    vi.mocked(inspectProjectCreationTarget).mockReturnValue({
      requestedPath: '/repo-root/new-project',
      absolutePath: '/repo-root/new-project',
      state: 'missing',
    });
    vi.mocked(createEmptyGitProject).mockReturnValue({
      requestedPath: '/repo-root/new-project',
      projectRoot: '/repo-root/new-project',
      projectName: 'new-project',
    });

    const setStatusMessage = vi.fn();
    const saveSidebarProjects = vi.fn(async (projects) => projects);
    const popupManager = {
      launchProjectSelectPopup: vi.fn(async () => '/repo-root/new-project'),
      launchConfirmPopup: vi.fn(async () => true),
    };

    const projectActionItems: ProjectActionItem[] = [
      {
        index: 0,
        projectRoot: '/repo-root',
        projectName: 'repo-root',
        kind: 'new-agent',
        hotkey: 'n',
      },
    ];

    const { stdin, unmount } = render(
      <Harness
        selectedIndex={0}
        projectActionItems={projectActionItems}
        popupManager={popupManager}
        setStatusMessage={setStatusMessage}
        saveSidebarProjects={saveSidebarProjects}
      />
    );

    await sleep(20);
    stdin.write('p');
    await sleep(60);

    expect(popupManager.launchProjectSelectPopup).toHaveBeenCalledWith('/repo-root', '/repo-root');
    expect(popupManager.launchConfirmPopup).toHaveBeenCalledWith(
      'Create Project',
      'This project does not exist yet:\n/repo-root/new-project\n\nCreate a new empty git repository here?',
      'Create Project',
      'Cancel',
      '/repo-root'
    );
    expect(createEmptyGitProject).toHaveBeenCalledWith('/repo-root/new-project', '/repo-root');
    expect(saveSidebarProjects).toHaveBeenCalledWith([
      { projectRoot: '/repo-root', projectName: 'repo-root' },
      { projectRoot: '/repo-selected', projectName: 'repo-selected' },
      {
        projectRoot: '/repo-root/new-project',
        projectName: 'new-project',
        colorTheme: 'red',
        colorThemeSource: 'auto',
      },
    ]);
    expect(setStatusMessage).toHaveBeenCalledWith('Created new-project and added it to the sidebar');

    unmount();
  });

  it('opens the resumable branch picker for the currently selected sidebar project', async () => {
    const resumableBranches = [
      {
        branchName: 'feature-a',
        slug: 'feature-a',
        path: '/repo-selected/.dmux/worktrees/feature-a',
        lastModified: new Date('2026-03-12T12:00:00.000Z'),
        hasUncommittedChanges: false,
        hasWorktree: true,
        hasLocalBranch: true,
        hasRemoteBranch: false,
        isRemote: false,
      },
    ];
    vi.mocked(getResumableBranches).mockReturnValue(resumableBranches);

    const popupManager = {
      launchReopenWorktreePopup: vi.fn(async () => null),
    };
    const trackProjectActivity = vi.fn(async (work: () => unknown) => await work());

    const projectActionItems: ProjectActionItem[] = [
      {
        index: 0,
        projectRoot: '/repo-selected',
        projectName: 'repo-selected',
        kind: 'new-agent',
        hotkey: 'n',
      },
    ];

    const { stdin, unmount } = render(
      <Harness
        selectedIndex={0}
        projectActionItems={projectActionItems}
        popupManager={popupManager}
        activeProjectRoot="/repo-selected"
        trackProjectActivity={trackProjectActivity}
      />
    );

    await sleep(20);
    stdin.write('r');
    await sleep(40);

    expect(getResumableBranches).toHaveBeenCalledWith('/repo-selected', [], {
      includeRemoteBranches: false,
    });
    expect(trackProjectActivity).toHaveBeenCalledWith(
      expect.any(Function),
      '/repo-selected'
    );
    expect(popupManager.launchReopenWorktreePopup).toHaveBeenCalledWith(
      resumableBranches,
      '/repo-selected',
      {
        includeWorktrees: true,
        includeLocalBranches: true,
        includeRemoteBranches: true,
        remoteLoaded: false,
        filterQuery: '',
      },
      []
    );

    unmount();
  });

  it('opens project settings for the active project root', async () => {
    const popupManager = {
      launchSettingsPopup: vi.fn(async () => null),
    };

    const projectActionItems: ProjectActionItem[] = [
      {
        index: 0,
        projectRoot: '/repo-selected',
        projectName: 'repo-selected',
        kind: 'new-agent',
        hotkey: 'n',
      },
    ];

    const { stdin, unmount } = render(
      <Harness
        selectedIndex={0}
        projectActionItems={projectActionItems}
        popupManager={popupManager}
        activeProjectRoot="/repo-selected"
      />
    );

    await sleep(20);
    stdin.write('s');
    await sleep(40);

    expect(popupManager.launchSettingsPopup).toHaveBeenCalledWith(
      expect.any(Function),
      '/repo-selected',
      [
        { projectRoot: '/repo-root', projectName: 'repo-root' },
        { projectRoot: '/repo-selected', projectName: 'repo-selected' },
      ]
    );

    unmount();
  });

  it('reopens the selected candidate returned from the popup', async () => {
    const resumableBranches = [
      {
        branchName: 'feature-a',
        slug: 'feature-a',
        path: '/repo-selected/.dmux/worktrees/feature-a',
        lastModified: new Date('2026-03-12T12:00:00.000Z'),
        hasUncommittedChanges: false,
        hasWorktree: true,
        hasLocalBranch: true,
        hasRemoteBranch: false,
        isRemote: false,
      },
    ];
    vi.mocked(getResumableBranches).mockReturnValue(resumableBranches);

    const selectedCandidate = {
      ...resumableBranches[0],
      lastModified: '2026-03-12T12:00:00.000Z',
    };

    const handleReopenWorktree = vi.fn(async () => {});
    const popupManager = {
      launchReopenWorktreePopup: vi.fn().mockResolvedValue({
        action: 'select',
        candidate: selectedCandidate,
      }),
    };
    const trackProjectActivity = vi.fn(async (work: () => unknown) => await work());

    const projectActionItems: ProjectActionItem[] = [
      {
        index: 0,
        projectRoot: '/repo-selected',
        projectName: 'repo-selected',
        kind: 'new-agent',
        hotkey: 'n',
      },
    ];

    const { stdin, unmount } = render(
      <Harness
        selectedIndex={0}
        projectActionItems={projectActionItems}
        popupManager={popupManager}
        activeProjectRoot="/repo-selected"
        trackProjectActivity={trackProjectActivity}
        handleReopenWorktree={handleReopenWorktree}
      />
    );

    await sleep(20);
    stdin.write('r');
    await sleep(60);

    expect(getResumableBranches).toHaveBeenNthCalledWith(1, '/repo-selected', [], {
      includeRemoteBranches: false,
    });
    expect(popupManager.launchReopenWorktreePopup).toHaveBeenNthCalledWith(
      1,
      resumableBranches,
      '/repo-selected',
      {
        includeWorktrees: true,
        includeLocalBranches: true,
        includeRemoteBranches: true,
        remoteLoaded: false,
        filterQuery: '',
      },
      []
    );
    expect(trackProjectActivity).toHaveBeenCalledTimes(1);
    expect(handleReopenWorktree).toHaveBeenCalledWith(
      {
        ...resumableBranches[0],
        lastModified: new Date('2026-03-12T12:00:00.000Z'),
      },
      '/repo-selected'
    );

    unmount();
  });
});
