import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());
const createPaneMock = vi.hoisted(() => vi.fn());
const triggerHookMock = vi.hoisted(() => vi.fn(async () => {}));
const writeWorktreeMetadataMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock('../src/utils/paneCreation.js', () => ({
  createPane: createPaneMock,
}));

vi.mock('../src/utils/hooks.js', () => ({
  triggerHook: triggerHookMock,
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  writeWorktreeMetadata: writeWorktreeMetadataMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      permissionMode: 'plan',
      linkedRepoPaths: 'child-repo',
    })),
  })),
}));

function createTempRepoDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
  return tempDir;
}

type MockCommandOptions = {
  cwd?: string;
  encoding?: string;
  stdio?: string;
  maxBuffer?: number;
};

function installGitCommandMock(
  handler: (command: string, options?: MockCommandOptions) => string | Buffer
): void {
  execSyncMock.mockImplementation((command: string, options?: MockCommandOptions) => (
    handler(command, options)
  ));

  execMock.mockImplementation((
    command: string,
    optionsOrCallback?: MockCommandOptions | ((error: Error | null, stdout?: string, stderr?: string) => void),
    maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void
  ) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;

    if (!callback) {
      throw new Error('exec callback is required in test mock');
    }

    try {
      const result = handler(command, options);
      callback(null, typeof result === 'string' ? result : result.toString('utf-8'), '');
    } catch (error) {
      callback(error as Error, '', '');
    }

    return {} as any;
  });
}

describe('resumeBranches', () => {
  let rootRepo: string;
  let childRepo: string;
  let orphanedRootWorktree: string;

  beforeEach(() => {
    vi.clearAllMocks();

    rootRepo = createTempRepoDir('dmux-resume-root-');
    childRepo = path.join(rootRepo, 'child-repo');
    fs.mkdirSync(path.join(childRepo, '.git'), { recursive: true });

    orphanedRootWorktree = path.join(rootRepo, '.dmux', 'worktrees', 'reopen-me');
    fs.mkdirSync(orphanedRootWorktree, { recursive: true });
    fs.writeFileSync(path.join(orphanedRootWorktree, '.git'), 'gitdir: /tmp/reopen-me\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(rootRepo, { recursive: true, force: true });
  });

  it('fetches remotes before deduping orphaned worktrees with local and remote branches', async () => {
    let rootRemoteFetched = false;
    let childRemoteFetched = false;

    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (
        cwd === orphanedRootWorktree
        && (
          command.includes("'branch' '--show-current'")
          || command.includes('branch --show-current')
        )
      ) {
        return output('feature/reopen-me');
      }
      if (
        cwd === orphanedRootWorktree
        && (
          command.includes("'status' '--porcelain'")
          || command.includes('status --porcelain')
        )
      ) {
        return output('M  src/index.ts');
      }

      if (cwd === rootRepo && command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (cwd === childRepo && command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }

      if (cwd === rootRepo && command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (cwd === childRepo && command.includes("'branch' '--show-current'")) {
        return output('main');
      }

      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nfeature/local-parent');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('child/local-only');
      }

      if (command.includes("'fetch' '--prune' 'origin'")) {
        if (cwd === rootRepo) {
          rootRemoteFetched = true;
        }
        if (cwd === childRepo) {
          childRemoteFetched = true;
        }
        return output('');
      }

      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output(rootRemoteFetched ? 'origin/feature/reopen-me\norigin/feature/remote-only' : '');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output(childRemoteFetched ? 'origin/feature/remote-only\norigin/child/remote-child-only' : '');
      }

      return output('');
    });

    const { getResumableBranches } = await import('../src/utils/resumeBranches.js');

    const candidates = getResumableBranches(rootRepo, []);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchName: 'feature/reopen-me',
          slug: 'reopen-me',
          path: orphanedRootWorktree,
          hasUncommittedChanges: true,
          hasWorktree: true,
          hasLocalBranch: true,
          hasRemoteBranch: true,
          isRemote: false,
        }),
        expect.objectContaining({
          branchName: 'child/local-only',
          hasWorktree: false,
          hasLocalBranch: true,
          hasRemoteBranch: false,
          isRemote: false,
        }),
        expect.objectContaining({
          branchName: 'feature/remote-only',
          hasWorktree: false,
          hasLocalBranch: false,
          hasRemoteBranch: true,
          isRemote: true,
        }),
        expect.objectContaining({
          branchName: 'child/remote-child-only',
          hasWorktree: false,
          hasLocalBranch: false,
          hasRemoteBranch: true,
          isRemote: true,
        }),
      ])
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("'fetch' '--prune' 'origin'"),
      expect.objectContaining({ cwd: rootRepo, stdio: 'pipe' })
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("'fetch' '--prune' 'origin'"),
      expect.objectContaining({ cwd: childRepo, stdio: 'pipe' })
    );
  });

  it('skips remote branch scans until remote sources are requested', async () => {
    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (
        cwd === orphanedRootWorktree
        && (
          command.includes("'branch' '--show-current'")
          || command.includes('branch --show-current')
        )
      ) {
        return output('feature/reopen-me');
      }
      if (
        cwd === orphanedRootWorktree
        && (
          command.includes("'status' '--porcelain'")
          || command.includes('status --porcelain')
        )
      ) {
        return output('');
      }

      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nfeature/local-parent');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('child/local-only');
      }

      if (command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        throw new Error('remote branches should not be queried');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        throw new Error('remote branches should not be fetched');
      }

      return output('');
    });

    const { getResumableBranches } = await import('../src/utils/resumeBranches.js');

    const candidates = getResumableBranches(rootRepo, [], {
      includeRemoteBranches: false,
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchName: 'feature/reopen-me',
          hasRemoteBranch: false,
        }),
        expect.objectContaining({
          branchName: 'feature/local-parent',
          hasLocalBranch: true,
          hasRemoteBranch: false,
        }),
        expect.objectContaining({
          branchName: 'child/local-only',
          hasLocalBranch: true,
          hasRemoteBranch: false,
        }),
      ])
    );
  });

  it('refreshes remote branches across workspace repos before creating worktrees', async () => {
    const createdPaths: string[] = [];
    let childRemoteFetched = false;

    createPaneMock.mockResolvedValue({
      pane: {
        id: 'dmux-1',
        slug: 'remote-shared',
        branchName: 'feature/remote-shared',
        prompt: 'No initial prompt',
        paneId: '%1',
        projectRoot: rootRepo,
        projectName: path.basename(rootRepo),
        worktreePath: path.join(rootRepo, '.dmux', 'worktrees', 'remote-shared'),
      },
      needsAgentChoice: false,
    });

    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' 'feature/remote-shared@{upstream}'")) {
        return output('');
      }
      if (command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nfeature/remote-shared');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/feature/remote-shared');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output(childRemoteFetched ? 'origin/feature/remote-shared' : '');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        if (cwd === childRepo) {
          childRemoteFetched = true;
        }
        return output('');
      }
      if (command.includes("'symbolic-ref' 'refs/remotes/origin/HEAD'")) {
        return output('refs/remotes/origin/main');
      }
      if (command.includes("'show-ref' '--verify' '--quiet' 'refs/heads/main'")) {
        return output('');
      }
      if (command.includes("'rev-list' '--left-right' '--count' 'feature/remote-shared...origin/feature/remote-shared'")) {
        return output('0\t9');
      }
      if (command.includes("'branch' '--set-upstream-to=origin/feature/remote-shared' 'feature/remote-shared'")) {
        return output('');
      }
      if (command.includes("'branch' '-f' 'feature/remote-shared' 'origin/feature/remote-shared'")) {
        return output('');
      }
      if (command.includes("'branch' '--track' 'feature/remote-shared' 'origin/feature/remote-shared'")) {
        return output('');
      }
      if (command.includes("'branch' 'feature/remote-shared' 'main'")) {
        return output('');
      }
      if (command.includes("'worktree' 'prune'")) {
        return output('');
      }
      if (command.includes("'worktree' 'add'")) {
        const match = command.match(/'worktree' 'add' '([^']+)' 'feature\/remote-shared'/);
        if (match) {
          const worktreePath = match[1];
          createdPaths.push(worktreePath!);
          fs.mkdirSync(worktreePath!, { recursive: true });
          fs.writeFileSync(path.join(worktreePath!, '.git'), 'gitdir: /tmp/worktree\n', 'utf-8');
        }
        return output('');
      }

      return output('');
    });

    const { resumeBranchWorkspace } = await import('../src/utils/resumeBranches.js');

    await resumeBranchWorkspace({
      agent: 'codex',
      branchName: 'feature/remote-shared',
      projectRoot: rootRepo,
      existingPanes: [],
      sessionConfigPath: path.join(rootRepo, '.dmux', 'dmux.config.json'),
      sessionProjectRoot: rootRepo,
    });

    const rootWorktreePath = path.join(rootRepo, '.dmux', 'worktrees', 'remote-shared');
    const childWorktreePath = path.join(rootWorktreePath, 'child-repo');

    expect(createdPaths).toEqual([rootWorktreePath, childWorktreePath]);
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'fetch' '--prune' 'origin'"),
      expect.objectContaining({ cwd: rootRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'fetch' '--prune' 'origin'"),
      expect.objectContaining({ cwd: childRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'branch' '-f' 'feature/remote-shared' 'origin/feature/remote-shared'"),
      expect.objectContaining({ cwd: rootRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'branch' '--track' 'feature/remote-shared' 'origin/feature/remote-shared'"),
      expect.objectContaining({ cwd: childRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).not.toHaveBeenCalledWith(
      expect.stringContaining("'branch' 'feature/remote-shared' 'main'"),
      expect.objectContaining({ cwd: childRepo }),
      expect.any(Function)
    );
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining("'fetch' '--prune' 'origin'"),
      expect.anything()
    );
    expect(writeWorktreeMetadataMock).toHaveBeenCalledWith(
      rootWorktreePath,
      expect.objectContaining({
        agent: 'codex',
        permissionMode: 'plan',
        linkedRepoPaths: ['child-repo'],
        branchName: 'feature/remote-shared',
      })
    );
    expect(writeWorktreeMetadataMock).toHaveBeenCalledWith(
      childWorktreePath,
      expect.objectContaining({
        branchName: 'feature/remote-shared',
      })
    );
    expect(createPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '',
        agent: 'codex',
        projectRoot: rootRepo,
        existingWorktree: {
          slug: 'remote-shared',
          worktreePath: rootWorktreePath,
          branchName: 'feature/remote-shared',
        },
      }),
      ['codex']
    );
    expect(triggerHookMock).toHaveBeenCalledWith(
      'worktree_created',
      childRepo,
      undefined,
      expect.objectContaining({
        DMUX_AGENT: 'codex',
        DMUX_BRANCH: 'feature/remote-shared',
        DMUX_WORKTREE_PATH: childWorktreePath,
      })
    );
  });

  it('reuses existing local-only child branches without recreating them from main', async () => {
    const createdPaths: string[] = [];

    createPaneMock.mockResolvedValue({
      pane: {
        id: 'dmux-1',
        slug: 'react',
        branchName: 'react',
        prompt: 'No initial prompt',
        paneId: '%1',
        projectRoot: rootRepo,
        projectName: path.basename(rootRepo),
        worktreePath: path.join(rootRepo, '.dmux', 'worktrees', 'react'),
      },
      needsAgentChoice: false,
    });

    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (cwd === rootRepo && command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' 'react@{upstream}'")) {
        return output('origin/react');
      }
      if (command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nreact');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        return output('');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/react');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('');
      }
      if (command.includes("'worktree' 'prune'")) {
        return output('');
      }
      if (command.includes("'worktree' 'list' '--porcelain'")) {
        return output('');
      }
      if (command.includes("'branch' '--track' 'react' 'origin/react'")) {
        return output('');
      }
      if (cwd === childRepo && command.includes("'branch' 'react' 'main'")) {
        throw new Error('should not recreate an existing local-only branch from main');
      }
      if (command.includes("'worktree' 'add'")) {
        const match = command.match(/'worktree' 'add' '([^']+)' 'react'/);
        if (match) {
          const worktreePath = match[1];
          createdPaths.push(worktreePath!);
          fs.mkdirSync(worktreePath!, { recursive: true });
          fs.writeFileSync(path.join(worktreePath!, '.git'), 'gitdir: /tmp/worktree\n', 'utf-8');
        }
        return output('');
      }

      return output('');
    });

    const { resumeBranchWorkspace } = await import('../src/utils/resumeBranches.js');

    await resumeBranchWorkspace({
      agent: 'codex',
      branchName: 'react',
      projectRoot: rootRepo,
      existingPanes: [],
      sessionConfigPath: path.join(rootRepo, '.dmux', 'dmux.config.json'),
      sessionProjectRoot: rootRepo,
    });

    const rootWorktreePath = path.join(rootRepo, '.dmux', 'worktrees', 'react');
    const childWorktreePath = path.join(rootWorktreePath, 'child-repo');

    expect(createdPaths).toEqual([rootWorktreePath, childWorktreePath]);
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'branch' '--track' 'react' 'origin/react'"),
      expect.objectContaining({ cwd: rootRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).not.toHaveBeenCalledWith(
      expect.stringContaining("'branch' 'react' 'main'"),
      expect.objectContaining({ cwd: childRepo }),
      expect.any(Function)
    );
    expect(triggerHookMock).toHaveBeenCalledWith(
      'worktree_created',
      childRepo,
      undefined,
      expect.objectContaining({
        DMUX_BRANCH: 'react',
        DMUX_WORKTREE_PATH: childWorktreePath,
      })
    );
  });

  it('reuses an existing child worktree when that branch is already checked out there', async () => {
    const createdPaths: string[] = [];
    const rootWorktreePath = path.join(rootRepo, '.dmux', 'worktrees', 'react');
    const childWorktreePath = path.join(rootWorktreePath, 'child-repo');

    fs.mkdirSync(rootWorktreePath, { recursive: true });
    fs.writeFileSync(path.join(rootWorktreePath, '.git'), 'gitdir: /tmp/existing-root-worktree\n', 'utf-8');
    fs.mkdirSync(childWorktreePath, { recursive: true });
    fs.writeFileSync(path.join(childWorktreePath, '.git'), 'gitdir: /tmp/existing-child-worktree\n', 'utf-8');

    createPaneMock.mockResolvedValue({
      pane: {
        id: 'dmux-1',
        slug: 'react',
        branchName: 'react',
        prompt: 'No initial prompt',
        paneId: '%1',
        projectRoot: rootRepo,
        projectName: path.basename(rootRepo),
        worktreePath: rootWorktreePath,
      },
      needsAgentChoice: false,
    });

    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (cwd === childRepo && command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' 'react@{upstream}'")) {
        return output('');
      }
      if (cwd === rootWorktreePath && command.includes("'branch' '--show-current'")) {
        return output('react');
      }
      if (command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nreact');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        return output('');
      }
      if (command.includes("'worktree' 'prune'")) {
        return output('');
      }
      if (cwd === rootRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/react');
      }
      if (cwd === childRepo && command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/react');
      }
      if (cwd === childRepo && command.includes("'rev-list' '--left-right' '--count' 'react...origin/react'")) {
        return output('0\t3');
      }
      if (cwd === childRepo && command.includes("'worktree' 'list' '--porcelain'")) {
        return output(`worktree ${childWorktreePath}\nHEAD abc123\nbranch refs/heads/react\n`);
      }
      if (cwd === rootRepo && command.includes("'worktree' 'list' '--porcelain'")) {
        return output('');
      }
      if (command.includes("'branch' '--track' 'react' 'origin/react'")) {
        return output('');
      }
      if (cwd === childRepo && command.includes("'branch' '-f' 'react' 'origin/react'")) {
        throw new Error('should not force-update a branch already checked out in the target worktree');
      }
      if (command.includes("'worktree' 'add'")) {
        const match = command.match(/'worktree' 'add' '([^']+)' 'react'/);
        if (match) {
          const worktreePath = match[1];
          createdPaths.push(worktreePath!);
          fs.mkdirSync(worktreePath!, { recursive: true });
          fs.writeFileSync(path.join(worktreePath!, '.git'), 'gitdir: /tmp/root-worktree\n', 'utf-8');
        }
        return output('');
      }

      return output('');
    });

    const { resumeBranchWorkspace } = await import('../src/utils/resumeBranches.js');

    await resumeBranchWorkspace({
      agent: 'codex',
      branchName: 'react',
      projectRoot: rootRepo,
      existingPanes: [],
      sessionConfigPath: path.join(rootRepo, '.dmux', 'dmux.config.json'),
      sessionProjectRoot: rootRepo,
    });

    expect(createdPaths).toEqual([]);
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("'worktree' 'list' '--porcelain'"),
      expect.objectContaining({ cwd: childRepo, encoding: 'utf-8' }),
      expect.any(Function)
    );
    expect(execMock).not.toHaveBeenCalledWith(
      expect.stringContaining("'branch' '-f' 'react' 'origin/react'"),
      expect.objectContaining({ cwd: childRepo }),
      expect.any(Function)
    );
    expect(triggerHookMock).toHaveBeenCalledWith(
      'worktree_created',
      childRepo,
      undefined,
      expect.objectContaining({
        DMUX_BRANCH: 'react',
        DMUX_WORKTREE_PATH: childWorktreePath,
      })
    );
  });
});
