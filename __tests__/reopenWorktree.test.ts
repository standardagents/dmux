import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0' })),
}));

const tmuxServiceMock = vi.hoisted(() => ({
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getCurrentSessionNameSync: vi.fn(() => 'dmux-test'),
  paneExists: vi.fn(async () => true),
  setSessionOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%1'));
const setupSidebarLayoutMock = vi.hoisted(() => vi.fn(() => '%1'));
const recalculateAndApplyLayoutMock = vi.hoisted(() => vi.fn(async () => {}));
const getInstalledAgentsMock = vi.hoisted(() => vi.fn(async () => ['claude', 'codex']));
const filterEnabledAgentsMock = vi.hoisted(() => vi.fn((agents: string[]) => agents));
const destroyWelcomePaneCoordinatedMock = vi.hoisted(() => vi.fn());
const ensureWorkspaceWorktreesMock = vi.hoisted(() => vi.fn(async () => []));
const getConfiguredLinkedRepoPathsMock = vi.hoisted(() => vi.fn(() => []));
const writeWorktreeMetadataMock = vi.hoisted(() => vi.fn());
const readWorktreeMetadataMock = vi.hoisted(() => vi.fn(() => ({
  agent: 'codex',
  permissionMode: 'bypassPermissions',
  branchName: 'feature/reopen-me',
})));

vi.mock('fs', () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  ensurePaneBorderStatusForCurrentSession: vi.fn(() => {
    tmuxServiceMock.setSessionOptionSync(
      tmuxServiceMock.getCurrentSessionNameSync(),
      'pane-border-status',
      'top'
    );
  }),
  setupSidebarLayout: setupSidebarLayoutMock,
  splitPane: splitPaneMock,
  getTerminalDimensions: vi.fn(() => ({ width: 160, height: 40 })),
}));

vi.mock('../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  recalculateAndApplyLayout: recalculateAndApplyLayoutMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      enabledAgents: ['claude', 'codex'],
      enableAutopilotByDefault: false,
    })),
  })),
}));

vi.mock('../src/utils/agentDetection.js', () => ({
  getInstalledAgents: getInstalledAgentsMock,
  filterEnabledAgents: filterEnabledAgentsMock,
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  readWorktreeMetadata: readWorktreeMetadataMock,
  writeWorktreeMetadata: writeWorktreeMetadataMock,
}));

vi.mock('../src/utils/linkedWorktrees.js', () => ({
  ensureWorkspaceWorktrees: ensureWorkspaceWorktreesMock,
  getConfiguredLinkedRepoPaths: getConfiguredLinkedRepoPathsMock,
}));

vi.mock('../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn((slug: string) => slug),
}));

vi.mock('../src/utils/git.js', () => ({
  getCurrentBranch: vi.fn(() => 'feature/reopen-me'),
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

vi.mock('../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: vi.fn(),
}));

vi.mock('../src/utils/welcomePaneManager.js', () => ({
  destroyWelcomePaneCoordinated: destroyWelcomePaneCoordinatedMock,
}));

describe('reopenWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ controlPaneId: '%0' }));
    readWorktreeMetadataMock.mockReturnValue({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      branchName: 'feature/reopen-me',
    });
    ensureWorkspaceWorktreesMock.mockResolvedValue([]);
    getConfiguredLinkedRepoPathsMock.mockReturnValue([]);
  });

  it('ensures linked child worktrees before resuming an existing pane', async () => {
    readWorktreeMetadataMock.mockReturnValue({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      branchName: 'feature/reopen-me',
      linkedRepoPaths: ['packages/docs'],
    });
    ensureWorkspaceWorktreesMock.mockResolvedValue([
      {
        isRoot: true,
        repoPath: '/repo',
        relativePath: '',
        worktreePath: '/repo/.dmux/worktrees/reopen-me',
        createdWorktree: false,
      },
      {
        isRoot: false,
        repoPath: '/repo/packages/docs',
        relativePath: 'packages/docs',
        worktreePath: '/repo/.dmux/worktrees/reopen-me/packages/docs',
        createdWorktree: true,
      },
    ]);

    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.dmux/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    expect(ensureWorkspaceWorktreesMock).toHaveBeenCalledWith({
      projectRoot: '/repo',
      rootWorktreePath: '/repo/.dmux/worktrees/reopen-me',
      branchName: 'feature/reopen-me',
      linkedRepoPaths: ['packages/docs'],
      fallbackStartPointMode: 'current-head',
    });
    expect(writeWorktreeMetadataMock).toHaveBeenCalledWith(
      '/repo/.dmux/worktrees/reopen-me/packages/docs',
      { branchName: 'feature/reopen-me' }
    );
  });

  it('uses stored agent metadata and permission mode for resume', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    const result = await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.dmux/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%1',
      expect.stringMatching(
        /^export DMUX_PANE_ID='dmux-\d+'; export DMUX_TMUX_PANE_ID='%1'; codex --enable hooks resume --last --dangerously-bypass-approvals-and-sandbox$/
      )
    );
    expect(tmuxServiceMock.setSessionOptionSync).toHaveBeenCalledWith(
      'dmux-test',
      'pane-border-status',
      'top'
    );
    expect(result.pane.agent).toBe('codex');
    expect(result.pane.permissionMode).toBe('bypassPermissions');
  });

  it('destroys the welcome pane even when only shell panes already exist', async () => {
    const { reopenWorktree } = await import('../src/utils/reopenWorktree.js');

    await reopenWorktree({
      slug: 'reopen-me',
      worktreePath: '/repo/.dmux/worktrees/reopen-me',
      projectRoot: '/repo',
      existingPanes: [
        {
          id: 'dmux-1',
          slug: 'shell-1',
          prompt: '',
          paneId: '%9',
          type: 'shell',
          shellType: 'zsh',
        },
      ],
      sessionProjectRoot: '/repo',
      sessionConfigPath: '/repo/.dmux/dmux.config.json',
    });

    expect(destroyWelcomePaneCoordinatedMock).toHaveBeenCalledWith('/repo');
  });
});
