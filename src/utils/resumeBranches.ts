import { exec, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import path from 'path';
import type { DmuxPane } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { triggerHook } from './hooks.js';
import { getOrphanedWorktrees, isValidBranchName } from './git.js';
import { createPane } from './paneCreation.js';
import { shellQuote } from './promptStore.js';
import { SettingsManager } from './settingsManager.js';
import { getConfiguredLinkedRepoPaths, getWorkspaceRepoReferences } from './linkedWorktrees.js';
import { writeWorktreeMetadata } from './worktreeMetadata.js';

const REMOTE_FALLBACK = 'origin';
const RESUME_SCAN_EXCLUDED_DIRS = new Set([
  '.dmux',
  '.git',
  'node_modules',
  'vendor',
  '.pnpm',
  '.next',
  'dist',
  'build',
  'coverage',
]);

export interface ResumableBranchCandidate {
  branchName: string;
  slug?: string;
  path?: string;
  lastModified?: Date;
  hasUncommittedChanges: boolean;
  hasWorktree: boolean;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
  isRemote: boolean;
}

interface ResumableBranchRecord extends ResumableBranchCandidate {
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}

interface WorkspaceRepoState {
  repoPath: string;
  relativePath: string;
  remoteName: string;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}

export interface ResumeBranchWorkspaceOptions {
  branchName: string;
  agent: AgentName;
  projectRoot: string;
  existingPanes: DmuxPane[];
  sessionConfigPath?: string;
  sessionProjectRoot?: string;
}

export interface ResumableBranchScanOptions {
  includeRemoteBranches?: boolean;
}

function runGitText(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): string {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  try {
    return execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch (error) {
    if (options.silent) {
      return '';
    }
    throw error;
  }
}

async function runGitTextAsync(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): Promise<string> {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          if (options.silent) {
            resolve('');
            return;
          }
          reject(error);
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

function runGit(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): void {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  try {
    execSync(command, {
      cwd,
      stdio: 'pipe',
    });
  } catch (error) {
    if (!options.silent) {
      throw error;
    }
  }
}

async function runGitAsync(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): Promise<void> {
  await runGitTextAsync(cwd, args, options);
}

function isGitRepoRoot(dirPath: string): boolean {
  const gitPath = path.join(dirPath, '.git');
  if (!fs.existsSync(gitPath)) {
    return false;
  }

  try {
    return fs.statSync(gitPath).isDirectory() || fs.statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

function discoverWorkspaceRepos(projectRoot: string): string[] {
  return getWorkspaceRepoReferences(
    projectRoot,
    getConfiguredLinkedRepoPaths(projectRoot)
  ).map((reference) => reference.repoPath);
}

function listLocalBranches(repoPath: string): Set<string> {
  const output = runGitText(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function getCurrentBranchName(repoPath: string): string {
  return runGitText(repoPath, ['branch', '--show-current'], { silent: true }) || 'main';
}

function getPreferredRemoteName(repoPath: string): string {
  const upstream = runGitText(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { silent: true }
  );
  if (upstream.includes('/')) {
    return upstream.split('/')[0];
  }

  const currentBranch = getCurrentBranchName(repoPath);
  if (currentBranch && currentBranch !== 'HEAD') {
    const configuredRemote = runGitText(
      repoPath,
      ['config', `branch.${currentBranch}.remote`],
      { silent: true }
    );
    if (configuredRemote) {
      return configuredRemote;
    }
  }

  return REMOTE_FALLBACK;
}

function listRemoteBranches(repoPath: string, remoteName: string): Set<string> {
  const output = runGitText(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== `${remoteName}/HEAD`)
      .map((line) => (
        line.startsWith(`${remoteName}/`) ? line.slice(remoteName.length + 1) : line
      ))
      .filter(Boolean)
  );
}

function fetchRemoteBranches(repoPath: string, remoteName: string): void {
  runGit(
    repoPath,
    ['fetch', '--prune', remoteName],
    { silent: true }
  );
}

function compareCandidates(
  left: ResumableBranchCandidate,
  right: ResumableBranchCandidate
): number {
  if (left.path && right.path) {
    const leftTime = left.lastModified?.getTime() ?? 0;
    const rightTime = right.lastModified?.getTime() ?? 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
  } else if (left.path) {
    return -1;
  } else if (right.path) {
    return 1;
  }

  return left.branchName.localeCompare(right.branchName);
}

export function getResumableBranches(
  projectRoot: string,
  activePaneSlugs: string[],
  options: ResumableBranchScanOptions = {}
): ResumableBranchCandidate[] {
  const includeRemoteBranches = options.includeRemoteBranches ?? true;
  const candidates = new Map<string, ResumableBranchRecord>();

  for (const worktree of getOrphanedWorktrees(projectRoot, activePaneSlugs)) {
    candidates.set(worktree.branch, {
      branchName: worktree.branch,
      slug: worktree.slug,
      path: worktree.path,
      lastModified: worktree.lastModified,
      hasUncommittedChanges: worktree.hasUncommittedChanges,
      hasWorktree: true,
      isRemote: false,
      hasLocalBranch: true,
      hasRemoteBranch: false,
    });
  }

  for (const repoPath of discoverWorkspaceRepos(projectRoot)) {
    const localBranches = listLocalBranches(repoPath);
    let remoteBranches = new Set<string>();
    if (includeRemoteBranches) {
      const remoteName = getPreferredRemoteName(repoPath);
      fetchRemoteBranches(repoPath, remoteName);
      remoteBranches = listRemoteBranches(repoPath, remoteName);
    }
    const branchNames = new Set<string>([
      ...Array.from(localBranches),
      ...Array.from(remoteBranches),
    ]);

    for (const branchName of branchNames) {
      const existing = candidates.get(branchName);
      if (existing) {
        existing.hasWorktree ||= false;
        existing.hasLocalBranch ||= localBranches.has(branchName);
        existing.hasRemoteBranch ||= remoteBranches.has(branchName);
        continue;
      }

      candidates.set(branchName, {
        branchName,
        hasUncommittedChanges: false,
        hasWorktree: false,
        isRemote: false,
        hasLocalBranch: localBranches.has(branchName),
        hasRemoteBranch: remoteBranches.has(branchName),
      });
    }
  }

  return Array.from(candidates.values())
    .map((candidate) => ({
      branchName: candidate.branchName,
      slug: candidate.slug,
      path: candidate.path,
      lastModified: candidate.lastModified,
      hasUncommittedChanges: candidate.hasUncommittedChanges,
      hasWorktree: candidate.hasWorktree,
      hasLocalBranch: candidate.hasLocalBranch,
      hasRemoteBranch: candidate.hasRemoteBranch,
      isRemote: !candidate.hasWorktree && !candidate.hasLocalBranch && candidate.hasRemoteBranch,
    }))
    .sort(compareCandidates);
}

function getWorkspaceBranchStates(
  projectRoot: string,
  branchName: string
): WorkspaceRepoState[] {
  return discoverWorkspaceRepos(projectRoot).map((repoPath) => {
    const remoteName = getPreferredRemoteName(repoPath);
    const localBranches = listLocalBranches(repoPath);
    const remoteBranches = listRemoteBranches(repoPath, remoteName);

    return {
      repoPath,
      relativePath: repoPath === projectRoot ? '' : path.relative(projectRoot, repoPath),
      remoteName,
      hasLocalBranch: localBranches.has(branchName),
      hasRemoteBranch: remoteBranches.has(branchName),
    };
  });
}

async function getWorkspaceBranchStatesAsync(
  projectRoot: string,
  branchName: string
): Promise<WorkspaceRepoState[]> {
  const repoStates: WorkspaceRepoState[] = [];

  for (const repoPath of discoverWorkspaceRepos(projectRoot)) {
    const remoteName = await getPreferredRemoteNameAsync(repoPath);
    const localBranches = await listLocalBranchesAsync(repoPath);
    const remoteBranches = await listRemoteBranchesAsync(repoPath, remoteName);

    repoStates.push({
      repoPath,
      relativePath: repoPath === projectRoot ? '' : path.relative(projectRoot, repoPath),
      remoteName,
      hasLocalBranch: localBranches.has(branchName),
      hasRemoteBranch: remoteBranches.has(branchName),
    });
  }

  return repoStates;
}

function refreshRemoteBranchState(
  state: WorkspaceRepoState,
  branchName: string
): void {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  runGit(
    state.repoPath,
    ['fetch', '--prune', state.remoteName],
    { silent: true }
  );

  state.hasRemoteBranch = listRemoteBranches(state.repoPath, state.remoteName).has(branchName);
}

async function refreshRemoteBranchStateAsync(
  state: WorkspaceRepoState,
  branchName: string
): Promise<void> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  await runGitAsync(
    state.repoPath,
    ['fetch', '--prune', state.remoteName],
    { silent: true }
  );

  state.hasRemoteBranch = (
    await listRemoteBranchesAsync(state.repoPath, state.remoteName)
  ).has(branchName);
}

function deriveBaseSlug(branchName: string): string {
  const segment = branchName.split('/').pop() || branchName;
  const normalized = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'branch';
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function hasReusableWorktreeForBranch(
  worktreeRootPath: string,
  branchName: string
): boolean {
  const rootGitPath = path.join(worktreeRootPath, '.git');
  if (fs.existsSync(rootGitPath)) {
    return getCurrentBranchName(worktreeRootPath) === branchName;
  }

  const stack = [worktreeRootPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (RESUME_SCAN_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const gitPath = path.join(fullPath, '.git');
      if (fs.existsSync(gitPath)) {
        try {
          const gitStat = fs.statSync(gitPath);
          if (gitStat.isFile() && getCurrentBranchName(fullPath) === branchName) {
            return true;
          }
        } catch {
          // Ignore unreadable nested worktrees and keep scanning.
        }
      }

      stack.push(fullPath);
    }
  }

  return false;
}

function getAvailableSlug(
  branchName: string,
  projectRoot: string,
  existingPanes: DmuxPane[]
): string {
  const worktreesDir = path.join(projectRoot, '.dmux', 'worktrees');
  const reserved = new Set(existingPanes.map((pane) => pane.slug));
  const baseSlug = deriveBaseSlug(branchName);
  let candidate = baseSlug;
  let attempt = 0;

  while (
    reserved.has(candidate)
    || (
      fs.existsSync(path.join(worktreesDir, candidate))
      && !hasReusableWorktreeForBranch(path.join(worktreesDir, candidate), branchName)
    )
  ) {
    attempt += 1;
    const hashSuffix = shortHash(`${branchName}:${attempt}`);
    candidate = `${baseSlug}-${hashSuffix}`;
  }

  return candidate;
}

function getBranchUpstream(repoPath: string, branchName: string): string {
  return runGitText(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchName}@{upstream}`],
    { silent: true }
  );
}

async function getBranchUpstreamAsync(repoPath: string, branchName: string): Promise<string> {
  return runGitTextAsync(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchName}@{upstream}`],
    { silent: true }
  );
}

function getBranchDivergence(
  repoPath: string,
  localRef: string,
  remoteRef: string
): { ahead: number; behind: number } {
  const output = runGitText(
    repoPath,
    ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
    { silent: true }
  );
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);

  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

async function getBranchDivergenceAsync(
  repoPath: string,
  localRef: string,
  remoteRef: string
): Promise<{ ahead: number; behind: number }> {
  const output = await runGitTextAsync(
    repoPath,
    ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
    { silent: true }
  );
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);

  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function getCheckedOutWorktreePath(
  repoPath: string,
  branchName: string
): string | null {
  const output = runGitText(
    repoPath,
    ['worktree', 'list', '--porcelain'],
    { silent: true }
  );
  if (!output) {
    return null;
  }

  let currentWorktree: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length).trim();
      continue;
    }

    if (line === `branch refs/heads/${branchName}`) {
      return currentWorktree;
    }

    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return null;
}

async function getCheckedOutWorktreePathAsync(
  repoPath: string,
  branchName: string
): Promise<string | null> {
  const output = await runGitTextAsync(
    repoPath,
    ['worktree', 'list', '--porcelain'],
    { silent: true }
  );
  if (!output) {
    return null;
  }

  let currentWorktree: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length).trim();
      continue;
    }

    if (line === `branch refs/heads/${branchName}`) {
      return currentWorktree;
    }

    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return null;
}

function ensureLocalBranch(
  state: WorkspaceRepoState,
  branchName: string,
  worktreePath: string
): void {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  refreshRemoteBranchState(state, branchName);
  runGit(state.repoPath, ['worktree', 'prune'], { silent: true });
  state.hasLocalBranch = listLocalBranches(state.repoPath).has(branchName);

  if (state.hasRemoteBranch) {
    const remoteRef = `${state.remoteName}/${branchName}`;

    if (state.hasLocalBranch) {
      const upstream = getBranchUpstream(state.repoPath, branchName);
      if (upstream !== remoteRef) {
        runGit(
          state.repoPath,
          ['branch', `--set-upstream-to=${remoteRef}`, branchName],
          { silent: true }
        );
      }

      const { ahead, behind } = getBranchDivergence(
        state.repoPath,
        branchName,
        remoteRef
      );
      if (behind > 0 && ahead === 0) {
        const checkedOutWorktreePath = getCheckedOutWorktreePath(
          state.repoPath,
          branchName
        );
        if (checkedOutWorktreePath) {
          if (path.resolve(checkedOutWorktreePath) === path.resolve(worktreePath)) {
            return;
          }

          const repoLabel = state.relativePath || '.';
          throw new Error(
            `Branch ${branchName} in ${repoLabel} is already checked out at ${checkedOutWorktreePath}; reopen that worktree instead of recreating it.`
          );
        }

        runGit(state.repoPath, ['branch', '-f', branchName, remoteRef]);
      } else if (ahead > 0 && behind > 0) {
        const repoLabel = state.relativePath || '.';
        throw new Error(
          `Branch ${branchName} in ${repoLabel} has diverged from ${remoteRef}; refusing to overwrite local commits while opening the workspace.`
        );
      }

      return;
    }

    runGit(
      state.repoPath,
      ['branch', '--track', branchName, remoteRef]
    );
    state.hasLocalBranch = true;
    return;
  }

  if (state.hasLocalBranch) {
    return;
  }

  const defaultBranch = getMainBranchForRepo(state.repoPath);
  runGit(state.repoPath, ['branch', branchName, defaultBranch]);
  state.hasLocalBranch = true;
}

async function ensureLocalBranchAsync(
  state: WorkspaceRepoState,
  branchName: string,
  worktreePath: string
): Promise<void> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  await refreshRemoteBranchStateAsync(state, branchName);
  await runGitAsync(state.repoPath, ['worktree', 'prune'], { silent: true });
  state.hasLocalBranch = (await listLocalBranchesAsync(state.repoPath)).has(branchName);

  if (state.hasRemoteBranch) {
    const remoteRef = `${state.remoteName}/${branchName}`;

    if (state.hasLocalBranch) {
      const upstream = await getBranchUpstreamAsync(state.repoPath, branchName);
      if (upstream !== remoteRef) {
        await runGitAsync(
          state.repoPath,
          ['branch', `--set-upstream-to=${remoteRef}`, branchName],
          { silent: true }
        );
      }

      const { ahead, behind } = await getBranchDivergenceAsync(
        state.repoPath,
        branchName,
        remoteRef
      );
      if (behind > 0 && ahead === 0) {
        const checkedOutWorktreePath = await getCheckedOutWorktreePathAsync(
          state.repoPath,
          branchName
        );
        if (checkedOutWorktreePath) {
          if (path.resolve(checkedOutWorktreePath) === path.resolve(worktreePath)) {
            return;
          }

          const repoLabel = state.relativePath || '.';
          throw new Error(
            `Branch ${branchName} in ${repoLabel} is already checked out at ${checkedOutWorktreePath}; reopen that worktree instead of recreating it.`
          );
        }

        await runGitAsync(state.repoPath, ['branch', '-f', branchName, remoteRef]);
      } else if (ahead > 0 && behind > 0) {
        const repoLabel = state.relativePath || '.';
        throw new Error(
          `Branch ${branchName} in ${repoLabel} has diverged from ${remoteRef}; refusing to overwrite local commits while opening the workspace.`
        );
      }

      return;
    }

    await runGitAsync(
      state.repoPath,
      ['branch', '--track', branchName, remoteRef]
    );
    state.hasLocalBranch = true;
    return;
  }

  if (state.hasLocalBranch) {
    return;
  }

  const defaultBranch = await getMainBranchForRepoAsync(state.repoPath);
  await runGitAsync(state.repoPath, ['branch', branchName, defaultBranch]);
  state.hasLocalBranch = true;
}

function getMainBranchForRepo(repoPath: string): string {
  const originHead = runGitText(
    repoPath,
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { silent: true }
  );
  if (originHead.startsWith('refs/remotes/origin/')) {
    return originHead.slice('refs/remotes/origin/'.length);
  }

  try {
    runGit(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/main']);
    return 'main';
  } catch {
    // Continue to master fallback.
  }

  try {
    runGit(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/master']);
    return 'master';
  } catch {
    return getCurrentBranchName(repoPath) || 'main';
  }
}

async function getMainBranchForRepoAsync(repoPath: string): Promise<string> {
  const originHead = await runGitTextAsync(
    repoPath,
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { silent: true }
  );
  if (originHead.startsWith('refs/remotes/origin/')) {
    return originHead.slice('refs/remotes/origin/'.length);
  }

  try {
    await runGitAsync(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/main']);
    return 'main';
  } catch {
    // Continue to master fallback.
  }

  try {
    await runGitAsync(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/master']);
    return 'master';
  } catch {
    return (await getCurrentBranchNameAsync(repoPath)) || 'main';
  }
}

function createWorktree(repoPath: string, worktreePath: string, branchName: string): void {
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return;
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(repoPath, ['worktree', 'prune'], { silent: true });
  runGit(repoPath, ['worktree', 'add', worktreePath, branchName]);
}

async function createWorktreeAsync(
  repoPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return;
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await runGitAsync(repoPath, ['worktree', 'prune'], { silent: true });
  await runGitAsync(repoPath, ['worktree', 'add', worktreePath, branchName]);
}

async function listLocalBranchesAsync(repoPath: string): Promise<Set<string>> {
  const output = await runGitTextAsync(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function getCurrentBranchNameAsync(repoPath: string): Promise<string> {
  return (await runGitTextAsync(
    repoPath,
    ['branch', '--show-current'],
    { silent: true }
  )) || 'main';
}

async function getPreferredRemoteNameAsync(repoPath: string): Promise<string> {
  const upstream = await runGitTextAsync(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { silent: true }
  );
  if (upstream.includes('/')) {
    return upstream.split('/')[0];
  }

  const currentBranch = await getCurrentBranchNameAsync(repoPath);
  if (currentBranch && currentBranch !== 'HEAD') {
    const configuredRemote = await runGitTextAsync(
      repoPath,
      ['config', `branch.${currentBranch}.remote`],
      { silent: true }
    );
    if (configuredRemote) {
      return configuredRemote;
    }
  }

  return REMOTE_FALLBACK;
}

async function listRemoteBranchesAsync(
  repoPath: string,
  remoteName: string
): Promise<Set<string>> {
  const output = await runGitTextAsync(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== `${remoteName}/HEAD`)
      .map((line) => (
        line.startsWith(`${remoteName}/`) ? line.slice(remoteName.length + 1) : line
      ))
      .filter(Boolean)
  );
}

async function triggerChildWorktreeHook(
  projectRoot: string,
  branchName: string,
  slug: string,
  worktreePath: string,
  agent: AgentName
): Promise<void> {
  await triggerHook('worktree_created', projectRoot, undefined, {
    DMUX_SLUG: slug,
    DMUX_PROMPT: 'No initial prompt',
    DMUX_AGENT: agent,
    DMUX_WORKTREE_PATH: worktreePath,
    DMUX_BRANCH: branchName,
  });
}

export async function resumeBranchWorkspace(
  options: ResumeBranchWorkspaceOptions
): Promise<{ pane: DmuxPane }> {
  const {
    branchName,
    agent,
    projectRoot,
    existingPanes,
    sessionConfigPath,
    sessionProjectRoot,
  } = options;

  const linkedRepoPaths = getConfiguredLinkedRepoPaths(projectRoot);
  const workspaceStates = await getWorkspaceBranchStatesAsync(projectRoot, branchName);
  const slug = getAvailableSlug(branchName, projectRoot, existingPanes);
  const rootWorktreePath = path.join(projectRoot, '.dmux', 'worktrees', slug);
  const settings = new SettingsManager(projectRoot).getSettings();

  if (!agent) {
    throw new Error(`An agent must be selected before opening ${branchName}`);
  }

  for (const state of workspaceStates) {
    const worktreePath = state.relativePath
      ? path.join(rootWorktreePath, state.relativePath)
      : rootWorktreePath;
    await ensureLocalBranchAsync(state, branchName, worktreePath);
  }

  for (const state of workspaceStates) {
    const worktreePath = state.relativePath
      ? path.join(rootWorktreePath, state.relativePath)
      : rootWorktreePath;
    await createWorktreeAsync(state.repoPath, worktreePath, branchName);
    writeWorktreeMetadata(worktreePath, {
      ...(agent && !state.relativePath ? { agent } : {}),
      permissionMode: state.relativePath ? undefined : settings.permissionMode,
      branchName: branchName !== slug ? branchName : undefined,
      linkedRepoPaths: !state.relativePath && linkedRepoPaths.length > 0
        ? linkedRepoPaths
        : undefined,
    });
  }

  const creation = await createPane(
    {
      prompt: '',
      agent,
      existingWorktree: {
        slug,
        worktreePath: rootWorktreePath,
        branchName,
      },
      projectName: path.basename(projectRoot),
      existingPanes,
      projectRoot,
      sessionConfigPath,
      sessionProjectRoot,
    },
    [agent]
  );

  if (creation.needsAgentChoice) {
    throw new Error('Agent selection is required to resume this branch');
  }

  for (const state of workspaceStates) {
    if (!state.relativePath) {
      continue;
    }
    await triggerChildWorktreeHook(
      state.repoPath,
      branchName,
      slug,
      path.join(rootWorktreePath, state.relativePath),
      agent
    );
  }

  return {
    pane: creation.pane,
  };
}
