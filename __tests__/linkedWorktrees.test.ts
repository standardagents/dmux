import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      linkedRepoPaths: undefined,
    })),
  })),
}));

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

describe('linkedWorktrees', () => {
  let projectRoot: string;
  let childRepo: string;
  let rootWorktreePath: string;
  let childWorktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-linked-worktrees-'));
    childRepo = path.join(projectRoot, 'backend');
    rootWorktreePath = path.join(projectRoot, '.dmux', 'worktrees', 'feature-test');
    childWorktreePath = path.join(rootWorktreePath, 'backend');

    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(childRepo, '.git'), { recursive: true });
    fs.mkdirSync(rootWorktreePath, { recursive: true });
    fs.writeFileSync(path.join(rootWorktreePath, '.git'), 'gitdir: /tmp/root-worktree\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('replaces an empty gitlink placeholder directory before attaching a child worktree', async () => {
    fs.mkdirSync(childWorktreePath, { recursive: true });

    const createdPaths: string[] = [];
    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (cwd === rootWorktreePath && command.includes("'branch' '--show-current'")) {
        return output('feature/test');
      }
      if (command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nfeature/test');
      }
      if (command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/feature/test');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        return output('');
      }
      if (command.includes("'worktree' 'prune'")) {
        return output('');
      }
      if (command.includes("'worktree' 'list' '--porcelain'")) {
        return output('');
      }
      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' 'feature/test@{upstream}'")) {
        return output('origin/feature/test');
      }
      if (command.includes("'rev-list' '--left-right' '--count' 'feature/test...origin/feature/test'")) {
        return output('0\t0');
      }
      if (command.includes("'worktree' 'add'")) {
        const match = command.match(/'worktree' 'add' '([^']+)' 'feature\/test'/);
        if (match) {
          createdPaths.push(match[1]!);
          fs.mkdirSync(match[1]!, { recursive: true });
          fs.writeFileSync(path.join(match[1]!, '.git'), 'gitdir: /tmp/child-worktree\n', 'utf-8');
        }
        return output('');
      }

      throw new Error(`Unhandled git command: ${command} (cwd=${cwd})`);
    });

    const { ensureWorkspaceWorktrees } = await import('../src/utils/linkedWorktrees.js');

    const targets = await ensureWorkspaceWorktrees({
      projectRoot,
      rootWorktreePath,
      branchName: 'feature/test',
      linkedRepoPaths: ['backend'],
      fallbackStartPointMode: 'current-head',
    });

    expect(targets).toEqual([
      {
        isRoot: true,
        repoPath: projectRoot,
        relativePath: '',
        worktreePath: rootWorktreePath,
        createdWorktree: false,
      },
      {
        isRoot: false,
        repoPath: childRepo,
        relativePath: 'backend',
        worktreePath: childWorktreePath,
        createdWorktree: true,
      },
    ]);
    expect(createdPaths).toEqual([childWorktreePath]);
    expect(fs.existsSync(path.join(childWorktreePath, '.git'))).toBe(true);
  });

  it('keeps rejecting non-empty directories that are not child worktrees', async () => {
    fs.mkdirSync(childWorktreePath, { recursive: true });
    fs.writeFileSync(path.join(childWorktreePath, 'README.md'), 'placeholder\n', 'utf-8');

    installGitCommandMock((command: string, options?: { cwd?: string; encoding?: string }) => {
      const cwd = options?.cwd;
      const encoding = options?.encoding;
      const output = (value: string) => encoding ? value : Buffer.from(value);

      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' '@{upstream}'")) {
        return output('origin/main');
      }
      if (cwd === rootWorktreePath && command.includes("'branch' '--show-current'")) {
        return output('feature/test');
      }
      if (command.includes("'branch' '--show-current'")) {
        return output('main');
      }
      if (command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/heads'")) {
        return output('main\nfeature/test');
      }
      if (command.includes("'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin'")) {
        return output('origin/feature/test');
      }
      if (command.includes("'fetch' '--prune' 'origin'")) {
        return output('');
      }
      if (command.includes("'worktree' 'prune'")) {
        return output('');
      }
      if (command.includes("'worktree' 'list' '--porcelain'")) {
        return output('');
      }
      if (command.includes("'rev-parse' '--abbrev-ref' '--symbolic-full-name' 'feature/test@{upstream}'")) {
        return output('origin/feature/test');
      }
      if (command.includes("'rev-list' '--left-right' '--count' 'feature/test...origin/feature/test'")) {
        return output('0\t0');
      }

      throw new Error(`Unhandled git command: ${command}`);
    });

    const { ensureWorkspaceWorktrees } = await import('../src/utils/linkedWorktrees.js');

    await expect(
      ensureWorkspaceWorktrees({
        projectRoot,
        rootWorktreePath,
        branchName: 'feature/test',
        linkedRepoPaths: ['backend'],
        fallbackStartPointMode: 'current-head',
      })
    ).rejects.toThrow(`Path already exists and is not a git worktree: ${childWorktreePath}`);
  });
});
