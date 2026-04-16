/**
 * Unit tests for openInEditorAction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openInEditor } from '../../src/actions/implementations/openInEditorAction.js';
import { createMockPane, createShellPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectSuccess, expectError } from '../helpers/actionAssertions.js';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('openInEditorAction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should open worktree in default editor (code)', async () => {
    delete process.env.EDITOR;
    const mockPane = createMockPane({
      worktreePath: '/test/worktree/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const result = await openInEditor(mockPane, mockContext);

    expect(execSync).toHaveBeenCalledWith(
      'code "/test/worktree/path"',
      { stdio: 'pipe' }
    );
    expectSuccess(result, 'code');
  });

  it('should use EDITOR environment variable when set', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const result = await openInEditor(mockPane, mockContext);

    expect(execSync).toHaveBeenCalledWith(
      'vim "/test/path"',
      { stdio: 'pipe' }
    );
    expectSuccess(result, 'vim');
  });

  it('should use custom editor from params', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    const result = await openInEditor(mockPane, mockContext, { editor: 'emacs' });

    expect(execSync).toHaveBeenCalledWith(
      'emacs "/test/path"',
      { stdio: 'pipe' }
    );
    expectSuccess(result, 'emacs');
  });

  it('should prioritize params editor over EDITOR env', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    await openInEditor(mockPane, mockContext, { editor: 'nano' });

    expect(execSync).toHaveBeenCalledWith(
      'nano "/test/path"',
      { stdio: 'pipe' }
    );
  });

  it('should return error for shell pane without worktree', async () => {
    const mockPane = createShellPane();
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should return error when editor command fails', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('editor not found');
    });

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'Failed to open');
  });

  it('should handle paths with spaces and special characters', async () => {
    delete process.env.EDITOR;
    const mockPane = createMockPane({
      worktreePath: '/test/path with spaces/worktree',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    await openInEditor(mockPane, mockContext);

    // Verify path is properly quoted
    expect(execSync).toHaveBeenCalledWith(
      'code "/test/path with spaces/worktree"',
      { stdio: 'pipe' }
    );
  });

  it('should support various editor commands', async () => {
    const editors = ['nvim', 'subl', 'atom', 'idea', 'webstorm'];
    const mockPane = createMockPane({ worktreePath: '/test' });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    for (const editor of editors) {
      vi.clearAllMocks();
      await openInEditor(mockPane, mockContext, { editor });

      expect(execSync).toHaveBeenCalledWith(
        `${editor} "/test"`,
        { stdio: 'pipe' }
      );
    }
  });
});
