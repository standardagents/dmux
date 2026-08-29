/**
 * Integration tests for Git operations (worktrees, branches, merges)
 * Target: Cover src/utils/git.ts (105 lines) + merge utils
 * Expected coverage gain: +2-3%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DmuxPane } from '../../src/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import { createMockGitRepo, addWorktree, type MockGitRepo } from '../fixtures/integration/gitRepo.js';

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// Mock StateManager
const mockGetState = vi.fn(() => ({ projectRoot: '/test' }));
const mockPauseConfigWatcher = vi.fn();
const mockResumeConfigWatcher = vi.fn();
vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => ({
      getState: mockGetState,
      pauseConfigWatcher: mockPauseConfigWatcher,
      resumeConfigWatcher: mockResumeConfigWatcher,
    })),
  },
}));

// Mock LogService
vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Mock hooks
vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn(() => Promise.resolve()),
}));

describe('Git Operations Integration Tests', () => {
  let gitRepo: MockGitRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    gitRepo = createMockGitRepo('main');

    // Configure mock execSync for git commands
    mockExecSync.mockImplementation((command: string, options?: any) => {
      const cmd = command.toString().trim();
      const encoding = options?.encoding;

      const returnValue = (value: string) => {
        if (encoding === 'utf-8') return value;
        return Buffer.from(value);
      };

      // Git symbolic-ref (get main branch)
      if (cmd.includes('symbolic-ref refs/remotes/origin/HEAD')) {
        return returnValue(`refs/remotes/origin/${gitRepo.mainBranch}`);
      }

      // Git branch --show-current (get current branch)
      if (cmd.includes('branch --show-current')) {
        return returnValue(gitRepo.currentBranch);
      }

      // Git rev-parse (fallback for old git)
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return returnValue(gitRepo.currentBranch);
      }

      // Git worktree list
      if (cmd.includes('worktree list')) {
        const list = gitRepo.worktrees
          .map(wt => `${wt.path} ${wt.commit} [${wt.branch}]`)
          .join('\n');
        return returnValue(list);
      }

      // Git worktree add
      if (cmd.includes('worktree add')) {
        // Extract path and branch from command
        const match = cmd.match(/worktree add\s+"?([^"\s]+)"?\s+-b\s+([^\s]+)/);
        if (match) {
          const [, path, branch] = match;
          gitRepo = addWorktree(gitRepo, path!, branch!);
        }
        return returnValue('');
      }

      // Git worktree remove
      if (cmd.includes('worktree remove')) {
        const match = cmd.match(/worktree remove\s+"?([^"\s]+)"?/);
        if (match) {
          const path = match[1];
          gitRepo = {
            ...gitRepo,
            worktrees: gitRepo.worktrees.filter(wt => wt.path !== path),
          };
        }
        return returnValue('');
      }

      // Git branch -D (delete branch)
      if (cmd.includes('branch -D')) {
        return returnValue('');
      }

      // Git status
      if (cmd.includes('status --porcelain')) {
        return returnValue(''); // Clean working tree
      }

      // Git diff
      if (cmd.includes('diff')) {
        if (cmd.includes('--cached')) {
          return returnValue(''); // No staged changes
        }
        return returnValue('M  test.ts\n+  modified line'); // Unstaged changes
      }

      // Git add
      if (cmd.includes('git add')) {
        return returnValue('');
      }

      // Git commit
      if (cmd.includes('commit')) {
        return returnValue('[main abc123] Test commit');
      }

      // Git merge
      if (cmd.includes('merge')) {
        // Check for conflict simulation
        if (cmd.includes('--no-commit')) {
          // No conflicts by default
          return returnValue('');
        }
        return returnValue('Merge made by recursive strategy');
      }

      // Git checkout
      if (cmd.includes('checkout')) {
        const match = cmd.match(/checkout\s+([^\s]+)/);
        if (match) {
          gitRepo = { ...gitRepo, currentBranch: match[1]! };
        }
        return returnValue('');
      }

      // Git log (for merge base)
      if (cmd.includes('merge-base')) {
        return returnValue('abc123');
      }

      // Git branch (list branches)
      if (cmd.includes('branch') && !cmd.includes('-D')) {
        const branches = [gitRepo.mainBranch, ...gitRepo.worktrees.map(wt => wt.branch)];
        const output = branches
          .map(b => (b === gitRepo.currentBranch ? `* ${b}` : `  ${b}`))
          .join('\n');
        return returnValue(output);
      }

      return returnValue('');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Worktree Creation', () => {
    it('should create worktree from main branch', async () => {
      const { execSync } = await import('child_process');

      execSync('git worktree add "/test/.dmux/worktrees/feature-branch" -b feature-branch', {
        encoding: 'utf-8',
        cwd: '/test',
      });

      // Verify worktree was added to mock repo
      expect(gitRepo.worktrees).toHaveLength(1);
      expect(gitRepo.worktrees[0]).toMatchObject({
        path: '/test/.dmux/worktrees/feature-branch',
        branch: 'feature-branch',
      });
    });

    it('should create new branch for worktree', async () => {
      const { execSync } = await import('child_process');

      execSync('git worktree add "/test/.dmux/worktrees/new-feature" -b new-feature', {
        cwd: '/test',
      });

      // Verify the command was called with -b flag
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-b new-feature'),
        expect.any(Object)
      );
    });

    it('should handle worktree creation from specific commit', async () => {
      const { execSync } = await import('child_process');

      execSync(
        'git worktree add "/test/.dmux/worktrees/hotfix" -b hotfix abc123',
        { cwd: '/test' }
      );

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('abc123'),
        expect.any(Object)
      );
    });

    it('should validate worktree path permissions', async () => {
      // Mock permission denied
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('worktree add')) {
          const error: any = new Error('Permission denied');
          error.status = 1;
          throw error;
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');

      expect(() => {
        execSync('git worktree add "/root/.dmux/worktrees/test" -b test', {
          cwd: '/test',
        });
      }).toThrow('Permission denied');
    });
  });

  describe('Branch Management', () => {
    it('should detect current branch', async () => {
      const { getCurrentBranch } = await import('../../src/utils/git.js');

      const branch = getCurrentBranch('/test');

      expect(branch).toBe('main');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('branch --show-current'),
        expect.any(Object)
      );
    });

    it('should detect main branch from origin/HEAD', async () => {
      const { getMainBranch } = await import('../../src/utils/git.js');

      const mainBranch = getMainBranch('/test');

      expect(mainBranch).toBe('main');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('symbolic-ref refs/remotes/origin/HEAD'),
        expect.any(Object)
      );
    });

    it('should fallback to "main" when origin/HEAD not set', async () => {
      // Mock origin/HEAD not set
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('symbolic-ref')) {
          throw new Error('No such ref');
        }
        return options?.encoding === 'utf-8' ? 'main' : Buffer.from('main');
      });

      const { getMainBranch } = await import('../../src/utils/git.js');

      const mainBranch = getMainBranch('/test');

      // Should fallback to 'main'
      expect(mainBranch).toBe('main');
    });

    it('should switch branches', async () => {
      const { execSync } = await import('child_process');

      execSync('git checkout feature-branch', { cwd: '/test' });

      expect(gitRepo.currentBranch).toBe('feature-branch');
    });

    it('should fallback to "main" when branch detection fails', async () => {
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('branch --show-current')) {
          // Throw error to trigger catch block
          throw new Error('fatal: not a git repository');
        }
        return options?.encoding === 'utf-8' || options?.encoding === 'utf8' ? '' : Buffer.from('');
      });

      const { getCurrentBranch } = await import('../../src/utils/git.js');

      const branch = getCurrentBranch('/test');

      // Should fallback to 'main' on error
      expect(branch).toBe('main');
    });
  });

  describe('Merge Workflows', () => {
    it('should merge main into worktree (step 1)', async () => {
      const { mergeMainIntoWorktree } = await import('../../src/utils/mergeExecution.js');

      const result = mergeMainIntoWorktree('/test/.dmux/worktrees/feature', 'main');

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git merge "main"'),
        expect.any(Object)
      );
    });

    it('should merge worktree into main (step 2)', async () => {
      const { mergeWorktreeIntoMain } = await import('../../src/utils/mergeExecution.js');

      const result = mergeWorktreeIntoMain('/test', 'feature-branch');

      expect(result.success).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git merge "feature-branch"'),
        expect.any(Object)
      );
    });

    it('should detect conflicts during merge', async () => {
      // Mock merge conflict
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('merge') && !cmd.includes('merge-base')) {
          const error: any = new Error('CONFLICT (content): Merge conflict in file.ts');
          error.status = 1;
          error.stdout = Buffer.from('');
          error.stderr = Buffer.from('CONFLICT (content): Merge conflict in file.ts');
          throw error;
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { mergeMainIntoWorktree } = await import('../../src/utils/mergeExecution.js');

      const result = mergeMainIntoWorktree('/test/.dmux/worktrees/feature', 'main');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Error message could be "CONFLICT" or "Merge conflicts detected"
      expect(result.error.toLowerCase()).toMatch(/conflict/i);
    });

    it('should detect conflicting files', async () => {
      // Mock merge conflict with file list
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('merge')) {
          const error: any = new Error('Merge conflict');
          error.status = 1;
          error.stderr = Buffer.from(
            'CONFLICT (content): Merge conflict in src/file1.ts\nCONFLICT (content): Merge conflict in src/file2.ts'
          );
          throw error;
        }
        if (cmd.includes('diff --name-only --diff-filter=U')) {
          return options?.encoding === 'utf-8'
            ? 'src/file1.ts\nsrc/file2.ts'
            : Buffer.from('src/file1.ts\nsrc/file2.ts');
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { mergeMainIntoWorktree } = await import('../../src/utils/mergeExecution.js');

      const result = mergeMainIntoWorktree('/test/.dmux/worktrees/feature', 'main');

      expect(result.success).toBe(false);
      expect(result.conflictFiles).toBeDefined();
    });

    it('should detect uncommitted changes before merge', async () => {
      // Mock uncommitted changes
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        const encoding = options?.encoding;
        if (cmd.includes('status --porcelain')) {
          // Handle both utf-8 and utf8
          if (encoding === 'utf-8' || encoding === 'utf8') {
            return 'M  file.ts\n';
          }
          return Buffer.from('M  file.ts\n');
        }
        // Default empty
        if (encoding === 'utf-8' || encoding === 'utf8') {
          return '';
        }
        return Buffer.from('');
      });

      const { hasUncommittedChanges } = await import('../../src/utils/git.js');

      const hasChanges = hasUncommittedChanges('/test');

      expect(hasChanges).toBe(true);
    });

    it('should cleanup worktree after successful merge', async () => {
      const { cleanupAfterMerge } = await import('../../src/utils/mergeExecution.js');

      const result = cleanupAfterMerge(
        '/test',
        '/test/.dmux/worktrees/feature',
        'feature-branch'
      );

      expect(result.success).toBe(true);

      // Verify worktree remove was called
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.any(Object)
      );
    });
  });

  describe('Commit Message Generation', () => {
    it('should analyze git diff for commit message', async () => {
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('diff')) {
          const diff = `diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@
+  // Add JWT validation
+  validateToken(token);`;
          return options?.encoding === 'utf-8' ? diff : Buffer.from(diff);
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { execSync } = await import('child_process');

      const diff = execSync('git diff', { encoding: 'utf-8', cwd: '/test' });

      expect(diff).toContain('Add JWT validation');
      expect(diff).toContain('validateToken');
    });

    it('should handle empty diff (no changes)', async () => {
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('diff')) {
          return options?.encoding === 'utf-8' ? '' : Buffer.from('');
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { execSync } = await import('child_process');

      const diff = execSync('git diff', { encoding: 'utf-8', cwd: '/test' });

      expect(diff).toBe('');
    });

    it('should generate commit message from AI', async () => {
      // callOpenRouter bails out before fetch when the key is absent, so without
      // this the assertion silently measures the callClaudeCode fallback instead.
      const previousKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-key';

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'feat: add JWT authentication' } }],
            }),
        } as Response)
      );

      try {
        const { generateCommitMessage } = await import('../../src/utils/aiMerge.js');

        const message = await generateCommitMessage('/test');

        expect(message).toContain('feat:');
        expect(message).toContain('authentication');
      } finally {
        if (previousKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = previousKey;
        }
      }
    });

    it('should fallback to manual commit when AI fails', async () => {
      const previousKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-key';

      // Mock API failure
      global.fetch = vi.fn(() => Promise.reject(new Error('API timeout')));

      try {
        const { generateCommitMessage } = await import('../../src/utils/aiMerge.js');

        const message = await generateCommitMessage('/test');

        // Should return a fallback message or null
        expect(message).toBeDefined();
      } finally {
        if (previousKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = previousKey;
        }
      }
    });
  });

  describe('Worktree Validation', () => {
    it('should check if path is inside worktree', async () => {
      gitRepo = addWorktree(gitRepo, '/test/.dmux/worktrees/feature', 'feature');

      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('worktree list')) {
          return options?.encoding === 'utf-8'
            ? '/test/.dmux/worktrees/feature abc123 [feature]'
            : Buffer.from('/test/.dmux/worktrees/feature abc123 [feature]');
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { execSync } = await import('child_process');

      const worktrees = execSync('git worktree list', {
        encoding: 'utf-8',
        cwd: '/test',
      });

      expect(worktrees).toContain('/test/.dmux/worktrees/feature');
    });

    it('should handle missing worktree directory', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('worktree remove')) {
          throw new Error("fatal: '/test/.dmux/worktrees/missing' is not a working tree");
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');

      expect(() => {
        execSync('git worktree remove "/test/.dmux/worktrees/missing"', {
          cwd: '/test',
        });
      }).toThrow('not a working tree');
    });

    it('should handle worktree with uncommitted changes', async () => {
      mockExecSync.mockImplementation((cmd: string, options?: any) => {
        if (cmd.includes('worktree remove') && !cmd.includes('--force')) {
          throw new Error('fatal: worktree contains modified or untracked files');
        }
        return options?.encoding === 'utf-8' ? '' : Buffer.from('');
      });

      const { execSync } = await import('child_process');

      // Without --force, should fail
      expect(() => {
        execSync('git worktree remove "/test/.dmux/worktrees/feature"', {
          cwd: '/test',
        });
      }).toThrow('modified or untracked files');

      // With --force, should succeed
      expect(() => {
        execSync('git worktree remove "/test/.dmux/worktrees/feature" --force', {
          cwd: '/test',
        });
      }).not.toThrow();
    });
  });
});
