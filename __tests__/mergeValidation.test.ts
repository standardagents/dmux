import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { getGitStatus } from '../src/utils/mergeValidation.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../src/utils/worktreeMetadata.js', () => ({
  readWorktreeMetadata: vi.fn(() => null),
}));

describe('mergeValidation', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('ignores dmux metadata directories when checking git status', () => {
    vi.mocked(execSync).mockReturnValue(
      '?? .dmux/\nM  .dmux/worktrees/feature-a\n'
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: false,
      files: [],
      summary: '',
    });
  });

  it('ignores untracked hook scaffolding but preserves real hook changes', () => {
    vi.mocked(execSync).mockReturnValue(
      [
        '?? .dmux-hooks/',
        '?? .dmux-hooks/AGENTS.md',
        '?? .dmux-hooks/examples/pre_merge.example',
        ' M .dmux-hooks/pre_merge',
        '?? .dmux-hooks/custom_hook',
      ].join('\n')
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: true,
      files: [
        '.dmux-hooks/pre_merge',
        '.dmux-hooks/custom_hook',
      ],
      summary: ' M .dmux-hooks/pre_merge\n?? .dmux-hooks/custom_hook',
    });
  });

  it('keeps non-dmux files in the dirty-state result', () => {
    vi.mocked(execSync).mockReturnValue(
      ' M src/index.ts\nM package.json\n'
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: true,
      files: ['src/index.ts', 'package.json'],
      summary: 'M src/index.ts\nM package.json',
    });
  });

  it('ignores linked nested repo paths when checking root repo status', async () => {
    const { readWorktreeMetadata } = await import('../src/utils/worktreeMetadata.js');
    vi.mocked(readWorktreeMetadata).mockReturnValue({
      linkedRepoPaths: ['backend', 'frontend'],
    });

    vi.mocked(execSync).mockReturnValue(
      ' M backend\n M frontend\nM src/index.ts\n'
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: true,
      files: ['src/index.ts'],
      summary: 'M src/index.ts',
    });
  });

  it('ignores untracked agent hook state scaffolding', () => {
    vi.mocked(execSync).mockReturnValue(
      [
        '?? .codex/',
        '?? .codex/hooks.json',
        '?? .codex/hooks/dmux-stop-hook.cjs',
        '?? .claude/',
        '?? .claude/settings.local.json',
      ].join('\n')
    );

    const status = getGitStatus('/repo');

    expect(status).toEqual({
      hasChanges: false,
      files: [],
      summary: '',
    });
  });
});
