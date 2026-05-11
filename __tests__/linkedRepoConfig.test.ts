import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverLinkedRepoPaths,
  parseLinkedRepoPathsInput,
  resolveLinkedRepoReferences,
  validateLinkedRepoPathsSetting,
} from '../src/utils/linkedRepoConfig.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('linkedRepoConfig', () => {
  it('parses newline and comma separated repo paths into a deduped list', () => {
    expect(parseLinkedRepoPathsInput('packages/docs, services/api\npackages/docs')).toEqual([
      'packages/docs',
      'services/api',
    ]);
  });

  it('rejects linked repo paths that escape the project root', () => {
    expect(() => validateLinkedRepoPathsSetting('../outside')).toThrow(
      'cannot escape the project root'
    );
  });

  it('resolves configured child repositories relative to the project root', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-linked-repos-'));
    tempDirs.push(projectRoot);

    const childRepo = path.join(projectRoot, 'packages', 'docs');
    fs.mkdirSync(path.join(childRepo, '.git'), { recursive: true });

    expect(resolveLinkedRepoReferences(projectRoot, 'packages/docs')).toEqual([
      {
        relativePath: 'packages/docs',
        repoPath: childRepo,
      },
    ]);
  });

  it('discovers nested child repositories while skipping generated directories', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-linked-repo-discovery-'));
    tempDirs.push(projectRoot);

    const childRepo = path.join(projectRoot, 'external', 'infinite-canvas-web');
    const nestedRepo = path.join(projectRoot, 'tools', 'workspace-helper');
    const ignoredRepo = path.join(projectRoot, 'node_modules', 'ignored-package');

    fs.mkdirSync(path.join(childRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(ignoredRepo, '.git'), { recursive: true });

    expect(discoverLinkedRepoPaths(projectRoot)).toEqual([
      'external/infinite-canvas-web',
      'tools/workspace-helper',
    ]);
  });
});
