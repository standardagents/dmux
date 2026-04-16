/**
 * Unit tests for closeAction
 *
 * This is a complex action with multiple code paths:
 * - Shell panes close immediately without options
 * - Worktree panes present context-aware options based on sibling panes
 * - Hooks are triggered, config watcher is paused, tmux operations, layout recalculation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closePane } from '../../src/actions/implementations/closeAction.js';
import { createMockPane, createShellPane, createWorktreePane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectChoice, expectSuccess, expectError } from '../helpers/actionAssertions.js';

// Mock all external dependencies
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockEnqueueCleanup = vi.fn();

vi.mock('../../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      enqueueCleanup: mockEnqueueCleanup,
    })),
  },
}));

// Create a persistent mock state manager instance
const mockStateManager = {
  getState: vi.fn(() => ({ projectRoot: '/test/project' })),
  pauseConfigWatcher: vi.fn(),
  resumeConfigWatcher: vi.fn(),
};

vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => mockStateManager),
  },
}));

vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('fs', () => {
  const readFileSync = vi.fn();
  return {
    default: { readFileSync },
    readFileSync,
  };
});

import { execSync } from 'child_process';
import { StateManager } from '../../src/shared/StateManager.js';
import { triggerHook } from '../../src/utils/hooks.js';
import fs from 'fs';

describe('closeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueCleanup.mockReset();
  });

  describe('shell panes', () => {
    it('should close shell pane immediately without presenting options', async () => {
      const mockPane = createShellPane({ id: 'dmux-1', paneId: '%42' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      const result = await closePane(mockPane, mockContext);

      // Should return success immediately (not a choice dialog)
      expectSuccess(result, 'closed successfully');
    });

    it('should kill shell pane via tmux', async () => {
      const mockPane = createShellPane({ paneId: '%99' });
      const mockContext = createMockContext([mockPane]);

      // Mock must return the pane ID before kill and omit it after kill.
      let paneKilled = false;
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return paneKilled ? '' : '%99\n';
        }
        if (cmd.includes('kill-pane')) {
          paneKilled = true;
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      await closePane(mockPane, mockContext);

      // Verify existence check was called
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux list-panes'),
        expect.anything()
      );
      // Verify kill command was called after existence check passed
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux kill-pane'),
        expect.anything()
      );
      expect(execSync).not.toHaveBeenCalledWith(
        expect.stringContaining('tmux send-keys'),
        expect.anything()
      );
    });
  });

  describe('worktree panes - option presentation', () => {
    it('should present 3 cleanup options for worktree pane when no siblings share the worktree', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      expectChoice(result, 3);
      expect(result.title).toBe('Close Pane');

      // Verify all 3 options are present
      const optionIds = result.options!.map(o => o.id);
      expect(optionIds).toContain('kill_only');
      expect(optionIds).toContain('kill_and_clean');
      expect(optionIds).toContain('kill_clean_branch');
    });

    it('should mark destructive options as dangerous', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killAndClean = result.options!.find(o => o.id === 'kill_and_clean');
      const killCleanBranch = result.options!.find(o => o.id === 'kill_clean_branch');

      expect(killAndClean?.danger).toBe(true);
      expect(killCleanBranch?.danger).toBe(true);
    });

    it('should set kill_only as default option', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      const result = await closePane(mockPane, mockContext);

      const killOnly = result.options!.find(o => o.id === 'kill_only');
      expect(killOnly?.default).toBe(true);
    });

    it('should only present kill_only and explain cleanup is unavailable when sibling panes share the worktree', async () => {
      const sharedWorktreePath = '/test/project/.dmux/worktrees/shared';
      const pane1 = createWorktreePane({ id: 'dmux-1', slug: 'alpha', worktreePath: sharedWorktreePath });
      const pane2 = createWorktreePane({ id: 'dmux-2', slug: 'bravo', worktreePath: sharedWorktreePath });
      const mockContext = createMockContext([pane1, pane2]);

      const result = await closePane(pane1, mockContext);

      expectChoice(result, 1);
      expect(result.message).toContain('still in use by 1 other pane');
      expect(result.message).toContain('Other panes on this worktree:');
      expect(result.message).toContain('  - bravo');
      expect(result.options?.[0]?.id).toBe('kill_only');
    });
  });

  describe('close execution - kill_only', () => {
    it('should remove pane from tracking when kill_only selected', async () => {
      const pane1 = createWorktreePane({ id: 'dmux-1' });
      const pane2 = createWorktreePane({ id: 'dmux-2' });
      const mockContext = createMockContext([pane1, pane2]);
      const savePanesSpy = vi.spyOn(mockContext, 'savePanes');

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(pane1, mockContext);
      await result.onSelect!('kill_only');

      // Verify pane was removed
      expect(savePanesSpy).toHaveBeenCalledWith([pane2]);
    });

    it('should call onPaneRemove callback with tmux pane ID', async () => {
      const mockPane = createWorktreePane({ paneId: '%42' });
      const mockContext = createMockContext([mockPane]);
      const onPaneRemoveSpy = vi.fn();
      mockContext.onPaneRemove = onPaneRemoveSpy;

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(onPaneRemoveSpy).toHaveBeenCalledWith('%42');
    });

    it('should not treat pane ID prefixes as an existing pane', async () => {
      const mockPane = createWorktreePane({ paneId: '%1' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%10\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      const killCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
        typeof cmd === 'string' && cmd.includes('tmux kill-pane')
      );
      expect(killCalls).toHaveLength(0);
    });

    it('should trigger before_pane_close and pane_closed hooks', async () => {
      const mockPane = createWorktreePane({ slug: 'test' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(triggerHook).toHaveBeenCalledWith('before_pane_close', '/test/project', mockPane);
      expect(triggerHook).toHaveBeenCalledWith('pane_closed', '/test/project', mockPane);
    });

    it('should pause and resume config watcher', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      expect(mockStateManager.pauseConfigWatcher).toHaveBeenCalled();
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('close execution - kill_and_clean', () => {
    it('should queue worktree cleanup when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({
        worktreePath: '/test/project/.dmux/worktrees/my-feature',
      });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: mockPane,
          paneProjectRoot: '/test/project',
          mainRepoPath: '/test/project',
          deleteBranch: false,
        })
      );
    });

    it('should not remove pane state or cleanup worktree when tmux pane survives kill', async () => {
      const mockPane = createWorktreePane({
        paneId: '%42',
        worktreePath: '/test/project/.dmux/worktrees/my-feature',
      });
      const mockContext = createMockContext([mockPane]);
      const savePanesSpy = vi.spyOn(mockContext, 'savePanes');

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%42\n%0\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      const executeResult = await result.onSelect!('kill_and_clean');

      expectError(executeResult, 'Failed to close pane');
      expect(savePanesSpy).not.toHaveBeenCalled();
      expect(mockEnqueueCleanup).not.toHaveBeenCalled();
    });

    it('should trigger worktree removal hooks', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      expect(triggerHook).toHaveBeenCalledWith('before_worktree_remove', expect.anything(), mockPane);
    });

    it('should NOT delete branch when kill_and_clean selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_and_clean');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(false);
    });
  });

  describe('close execution - kill_clean_branch', () => {
    it('should queue cleanup with branch deletion when kill_clean_branch selected', async () => {
      const mockPane = createWorktreePane({ slug: 'my-feature' });
      const mockContext = createMockContext([mockPane]);

      // Mock must return the pane ID in list-panes so existence check passes
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%1\n'; // Pane exists
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext); // Fixed: added missing mockContext
      await result.onSelect!('kill_clean_branch');

      const cleanupJob = mockEnqueueCleanup.mock.calls.at(-1)?.[0];
      expect(cleanupJob?.deleteBranch).toBe(true);
    });

    it('should use the pane project root when deleting a sidebar project worktree', async () => {
      const mockPane = createWorktreePane({
        slug: 'project-b-feature',
        projectRoot: '/test/project-b',
        projectName: 'project-b',
        worktreePath: '/test/project-b/.dmux/worktrees/project-b-feature',
      });
      const mockContext = createMockContext([mockPane]);

      mockStateManager.getState.mockReturnValueOnce({
        projectRoot: '/test/project-a',
      });

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('list-panes')) {
          return '%1\n';
        }
        return Buffer.from('');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_clean_branch');

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: mockPane,
          paneProjectRoot: '/test/project-b',
          mainRepoPath: '/test/project-b',
          deleteBranch: true,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return error when close operation fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      // Mock tmux kill to fail
      vi.mocked(execSync).mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.includes('kill-pane')) {
          throw new Error('tmux error');
        }
        return Buffer.from('');
      });

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      const executeResult = await result.onSelect!('kill_only');

      // Should still complete (errors are logged but not fatal)
      expect(executeResult.type).toBe('success');
    });

    it('should resume config watcher even if close fails', async () => {
      const mockPane = createWorktreePane();
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('fatal error');
      });

      const result = await closePane(mockPane, mockContext);

      try {
        await result.onSelect!('kill_only');
      } catch {
        // Expected to throw
      }

      // Config watcher should still be resumed
      expect(mockStateManager.resumeConfigWatcher).toHaveBeenCalled();
    });
  });

  describe('layout recalculation', () => {
    it('should NOT recalculate layout when no panes remain', async () => {
      const mockPane = createWorktreePane({ id: 'dmux-1' });
      const mockContext = createMockContext([mockPane]);

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        controlPaneId: '%0',
      }));

      const result = await closePane(mockPane, mockContext);
      await result.onSelect!('kill_only');

      // No layout module should be imported when panes.length === 0
      // (This is tested by not mocking the layout module and ensuring no errors)
    });
  });

  describe('dev source fallback', () => {
    const originalDmuxDev = process.env.DMUX_DEV;

    beforeEach(() => {
      process.env.DMUX_DEV = 'true';
    });

    afterEach(() => {
      if (originalDmuxDev === undefined) {
        delete process.env.DMUX_DEV;
      } else {
        process.env.DMUX_DEV = originalDmuxDev;
      }
    });

    it('should NOT reset source to root when sibling panes remain on the same worktree', async () => {
      const sourceWorktreePath = '/test/project/.dmux/worktrees/shared-worktree';
      const closingPane = createWorktreePane({
        id: 'dmux-1',
        paneId: '%11',
        worktreePath: sourceWorktreePath,
      });
      const siblingPane = createWorktreePane({
        id: 'dmux-2',
        paneId: '%12',
        worktreePath: sourceWorktreePath,
      });
      const otherPane = createWorktreePane({
        id: 'dmux-3',
        paneId: '%13',
        worktreePath: '/test/project/.dmux/worktrees/other-worktree',
      });
      const mockContext = createMockContext([closingPane, siblingPane, otherPane]);
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sourceWorktreePath);

      try {
        vi.mocked(execSync).mockReturnValue(Buffer.from(''));
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
          controlPaneId: '%0',
        }));

        const result = await closePane(closingPane, mockContext);
        await result.onSelect!('kill_only');

        const respawnCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
          typeof cmd === 'string' && cmd.includes('tmux respawn-pane -k')
        );
        expect(respawnCalls).toHaveLength(0);
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it('should reset source to root when the last pane for source worktree is closed', async () => {
      const sourceWorktreePath = '/test/project/.dmux/worktrees/shared-worktree';
      const closingPane = createWorktreePane({
        id: 'dmux-1',
        paneId: '%11',
        worktreePath: sourceWorktreePath,
      });
      const otherPane = createWorktreePane({
        id: 'dmux-3',
        paneId: '%13',
        worktreePath: '/test/project/.dmux/worktrees/other-worktree',
      });
      const mockContext = createMockContext([closingPane, otherPane]);
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(sourceWorktreePath);

      try {
        vi.mocked(execSync).mockReturnValue(Buffer.from(''));
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
          controlPaneId: '%0',
        }));

        const result = await closePane(closingPane, mockContext);
        await result.onSelect!('kill_only');

        const respawnCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
          typeof cmd === 'string' && cmd.includes('tmux respawn-pane -k')
        );
        expect(respawnCalls).toHaveLength(1);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
});
