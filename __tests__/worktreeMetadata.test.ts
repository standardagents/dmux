import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from '../src/utils/worktreeMetadata.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('worktree metadata persistence', () => {
  it('round-trips branch and merge-target metadata for reopened worktrees', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-worktree-meta-'));
    tempDirs.push(tempDir);

    writeWorktreeMetadata(tempDir, {
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      goalMode: true,
      displayName: 'Review Queue',
      branchName: 'feat/child-worktree',
      linkedRepoPaths: ['packages/design-system', 'services/api'],
      mergeTargetChain: [
        {
          displayName: 'Feature Parent',
          slug: 'feature-parent',
          branchName: 'feature-parent',
          worktreePath: '/repo/.dmux/worktrees/feature-parent',
        },
        {
          slug: 'main',
          branchName: 'main',
          worktreePath: '/repo',
        },
      ],
    });

    expect(readWorktreeMetadata(tempDir)).toEqual({
      agent: 'codex',
      permissionMode: 'bypassPermissions',
      goalMode: true,
      displayName: 'Review Queue',
      branchName: 'feat/child-worktree',
      linkedRepoPaths: ['packages/design-system', 'services/api'],
      mergeTargetChain: [
        {
          displayName: 'Feature Parent',
          slug: 'feature-parent',
          branchName: 'feature-parent',
          worktreePath: '/repo/.dmux/worktrees/feature-parent',
        },
        {
          slug: 'main',
          branchName: 'main',
          worktreePath: '/repo',
        },
      ],
    });
  });

  it('preserves an explicit empty linked repo selection so reopen does not fall back to project defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-worktree-meta-empty-'));
    tempDirs.push(tempDir);

    writeWorktreeMetadata(tempDir, {
      linkedRepoPaths: [],
    });

    expect(readWorktreeMetadata(tempDir)).toEqual({
      linkedRepoPaths: [],
    });
  });
});
