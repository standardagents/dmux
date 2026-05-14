import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SettingsManager } from './settingsManager.js';
import { isValidBranchName } from './git.js';
import { shellQuote } from './promptStore.js';
import {
  parseLinkedRepoPathsInput,
  resolveLinkedRepoReferences,
  type LinkedRepoReference,
} from './linkedRepoConfig.js';

const REMOTE_FALLBACK = 'origin';

export interface WorkspaceRepoReference extends LinkedRepoReference {
  isRoot: boolean;
}

interface WorkspaceRepoState extends WorkspaceRepoReference {
  remoteName: string;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}

export interface WorkspaceWorktreeTarget extends WorkspaceRepoReference {
  worktreePath: string;
  createdWorktree: boolean;
}

export interface EnsureWorkspaceWorktreesOptions {
  projectRoot: string;
  rootWorktreePath: string;
  branchName: string;
  linkedRepoPaths?: string[];
  preferredStartPoint?: string;
  fallbackStartPointMode?: 'current-head' | 'default-branch';
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

async function runGitAsync(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): Promise<void> {
  await runGitTextAsync(cwd, args, options);
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

function getCurrentBranchName(repoPath: string): string {
  return runGitText(repoPath, ['branch', '--show-current'], { silent: true }) || 'main';
}

async function getCurrentBranchNameAsync(repoPath: string): Promise<string> {
  return (await runGitTextAsync(
    repoPath,
    ['branch', '--show-current'],
    { silent: true }
  )) || 'main';
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

function fetchRemoteBranches(repoPath: string, remoteName: string): void {
  execSync(`git fetch --prune ${shellQuote(remoteName)}`, {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

async function fetchRemoteBranchesAsync(repoPath: string, remoteName: string): Promise<void> {
  await runGitAsync(repoPath, ['fetch', '--prune', remoteName], { silent: true });
}

async function getBranchUpstreamAsync(repoPath: string, branchName: string): Promise<string> {
  return runGitTextAsync(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchName}@{upstream}`],
    { silent: true }
  );
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

function getCheckedOutWorktreePath(repoPath: string, branchName: string): string | null {
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

async function getMainBranchForRepoAsync(repoPath: string): Promise<string> {
  const originHead = await runGitTextAsync(
    repoPath,
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { silent: true }
  );
  if (originHead.startsWith('refs/remotes/origin/')) {
    return originHead.slice('refs/remotes/origin/'.length);
  }

  const hasMain = await runGitTextAsync(
    repoPath,
    ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
    { silent: true }
  );
  if (hasMain === '') {
    // show-ref --quiet emits nothing on success, so verify via sync fallback below.
    try {
      execSync('git show-ref --verify --quiet refs/heads/main', {
        cwd: repoPath,
        stdio: 'pipe',
      });
      return 'main';
    } catch {
      // continue
    }
  }

  try {
    execSync('git show-ref --verify --quiet refs/heads/master', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return 'master';
  } catch {
    return (await getCurrentBranchNameAsync(repoPath)) || 'main';
  }
}

async function refExistsAsync(repoPath: string, refName: string): Promise<boolean> {
  const result = await runGitTextAsync(
    repoPath,
    ['rev-parse', '--verify', '--end-of-options', refName],
    { silent: true }
  );
  return result.length > 0;
}

async function getExistingWorktreeBranchAsync(worktreePath: string): Promise<string | null> {
  const gitPath = path.join(worktreePath, '.git');
  if (!fs.existsSync(gitPath)) {
    return null;
  }

  return (await getCurrentBranchNameAsync(worktreePath)) || null;
}

function ensureBranchName(branchName: string): void {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
}

function buildWorkspaceRepoStates(
  projectRoot: string,
  branchName: string,
  linkedRepoPaths?: string[]
): WorkspaceRepoState[] {
  const rootRepoPath = path.resolve(projectRoot);
  const repoReferences = [
    { relativePath: '', repoPath: rootRepoPath },
    ...resolveLinkedRepoReferences(rootRepoPath, linkedRepoPaths),
  ];

  return repoReferences.map((reference) => {
    const remoteName = getPreferredRemoteName(reference.repoPath);
    const localBranches = listLocalBranches(reference.repoPath);
    const remoteBranches = listRemoteBranches(reference.repoPath, remoteName);

    return {
      ...reference,
      isRoot: reference.relativePath.length === 0,
      remoteName,
      hasLocalBranch: localBranches.has(branchName),
      hasRemoteBranch: remoteBranches.has(branchName),
    };
  });
}

export function getConfiguredLinkedRepoPaths(projectRoot: string): string[] {
  return parseLinkedRepoPathsInput(
    new SettingsManager(projectRoot).getSettings().linkedRepoPaths
  );
}

export function getWorkspaceRepoReferences(
  projectRoot: string,
  linkedRepoPaths?: string[]
): WorkspaceRepoReference[] {
  const rootRepoPath = path.resolve(projectRoot);

  return [
    { isRoot: true, relativePath: '', repoPath: rootRepoPath },
    ...resolveLinkedRepoReferences(rootRepoPath, linkedRepoPaths).map((reference) => ({
      ...reference,
      isRoot: false,
    })),
  ];
}

export function getWorkspaceBranchStates(
  projectRoot: string,
  branchName: string,
  linkedRepoPaths?: string[]
): Array<{
  repoPath: string;
  relativePath: string;
  remoteName: string;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}> {
  return buildWorkspaceRepoStates(projectRoot, branchName, linkedRepoPaths).map((state) => ({
    repoPath: state.repoPath,
    relativePath: state.relativePath,
    remoteName: state.remoteName,
    hasLocalBranch: state.hasLocalBranch,
    hasRemoteBranch: state.hasRemoteBranch,
  }));
}

export function refreshWorkspaceRemoteBranches(
  projectRoot: string,
  branchName: string,
  linkedRepoPaths?: string[]
): void {
  ensureBranchName(branchName);
  for (const state of buildWorkspaceRepoStates(projectRoot, branchName, linkedRepoPaths)) {
    fetchRemoteBranches(state.repoPath, state.remoteName);
  }
}

async function getWorkspaceBranchStatesAsync(
  projectRoot: string,
  branchName: string,
  linkedRepoPaths?: string[]
): Promise<WorkspaceRepoState[]> {
  const repoReferences = getWorkspaceRepoReferences(projectRoot, linkedRepoPaths);
  const states: WorkspaceRepoState[] = [];

  for (const reference of repoReferences) {
    const remoteName = await getPreferredRemoteNameAsync(reference.repoPath);
    const localBranches = await listLocalBranchesAsync(reference.repoPath);
    const remoteBranches = await listRemoteBranchesAsync(reference.repoPath, remoteName);

    states.push({
      ...reference,
      remoteName,
      hasLocalBranch: localBranches.has(branchName),
      hasRemoteBranch: remoteBranches.has(branchName),
    });
  }

  return states;
}

function getWorktreePath(rootWorktreePath: string, relativePath: string): string {
  return relativePath
    ? path.join(rootWorktreePath, relativePath)
    : rootWorktreePath;
}

function isSafeEmptyPlaceholderDir(worktreePath: string): boolean {
  try {
    const stat = fs.statSync(worktreePath);
    if (!stat.isDirectory()) {
      return false;
    }

    const entries = fs.readdirSync(worktreePath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function ensureWorktreeAttached(
  state: WorkspaceRepoState,
  worktreePath: string,
  branchName: string,
  options: {
    preferredStartPoint?: string;
    fallbackStartPointMode: 'current-head' | 'default-branch';
  }
): Promise<boolean> {
  ensureBranchName(branchName);
  await fetchRemoteBranchesAsync(state.repoPath, state.remoteName);
  await runGitAsync(state.repoPath, ['worktree', 'prune'], { silent: true });

  const existingWorktreeBranch = await getExistingWorktreeBranchAsync(worktreePath);
  if (existingWorktreeBranch) {
    if (existingWorktreeBranch !== branchName) {
      throw new Error(
        `Existing worktree at ${worktreePath} is on ${existingWorktreeBranch}, expected ${branchName}`
      );
    }
    return false;
  }

  if (fs.existsSync(worktreePath)) {
    if (isSafeEmptyPlaceholderDir(worktreePath)) {
      fs.rmdirSync(worktreePath);
    } else {
      throw new Error(`Path already exists and is not a git worktree: ${worktreePath}`);
    }
  }

  state.hasLocalBranch = (await listLocalBranchesAsync(state.repoPath)).has(branchName);
  state.hasRemoteBranch = (
    await listRemoteBranchesAsync(state.repoPath, state.remoteName)
  ).has(branchName);

  const checkedOutWorktreePath = await getCheckedOutWorktreePathAsync(
    state.repoPath,
    branchName
  );
  if (checkedOutWorktreePath) {
    if (path.resolve(checkedOutWorktreePath) === path.resolve(worktreePath)) {
      return false;
    }

    const repoLabel = state.relativePath || '.';
    throw new Error(
      `Branch ${branchName} in ${repoLabel} is already checked out at ${checkedOutWorktreePath}; reopen that worktree instead of recreating it.`
    );
  }

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
        await runGitAsync(state.repoPath, ['branch', '-f', branchName, remoteRef]);
      } else if (ahead > 0 && behind > 0) {
        const repoLabel = state.relativePath || '.';
        throw new Error(
          `Branch ${branchName} in ${repoLabel} has diverged from ${remoteRef}; refusing to overwrite local commits while opening the workspace.`
        );
      }
    } else {
      await runGitAsync(
        state.repoPath,
        ['branch', '--track', branchName, remoteRef]
      );
      state.hasLocalBranch = true;
    }
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (state.hasLocalBranch) {
    await runGitAsync(state.repoPath, ['worktree', 'add', worktreePath, branchName]);
    return true;
  }

  const preferredStartPoint = options.preferredStartPoint?.trim();
  const resolvedStartPoint = preferredStartPoint && await refExistsAsync(state.repoPath, preferredStartPoint)
    ? preferredStartPoint
    : options.fallbackStartPointMode === 'default-branch'
      ? await getMainBranchForRepoAsync(state.repoPath)
      : await getCurrentBranchNameAsync(state.repoPath);

  const args = [
    'worktree',
    'add',
    worktreePath,
    '-b',
    branchName,
    ...(resolvedStartPoint ? [resolvedStartPoint] : []),
  ];

  await runGitAsync(state.repoPath, args);
  return true;
}

export async function ensureWorkspaceWorktrees(
  options: EnsureWorkspaceWorktreesOptions
): Promise<WorkspaceWorktreeTarget[]> {
  const linkedRepoPaths = options.linkedRepoPaths ?? getConfiguredLinkedRepoPaths(options.projectRoot);
  const repoStates = await getWorkspaceBranchStatesAsync(
    options.projectRoot,
    options.branchName,
    linkedRepoPaths
  );

  const targets: WorkspaceWorktreeTarget[] = [];

  for (const state of repoStates) {
    const worktreePath = getWorktreePath(options.rootWorktreePath, state.relativePath);
    const createdWorktree = await ensureWorktreeAttached(
      state,
      worktreePath,
      options.branchName,
      {
        preferredStartPoint: options.preferredStartPoint,
        fallbackStartPointMode: options.fallbackStartPointMode ?? 'default-branch',
      }
    );

    targets.push({
      isRoot: state.isRoot,
      repoPath: state.repoPath,
      relativePath: state.relativePath,
      worktreePath,
      createdWorktree,
    });
  }

  return targets;
}
