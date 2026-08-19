/**
 * Merge Validation Utilities
 *
 * Provides comprehensive pre-merge validation to detect issues before attempting merge
 */

import { execSync } from 'child_process';
import { LogService } from '../services/LogService.js';
import { getCurrentBranch as getCurrentBranchUtil } from './git.js';
import { normalizeLinkedRepoPathsArray, normalizeLinkedRepoPath } from './linkedRepoConfig.js';
import { readWorktreeMetadata } from './worktreeMetadata.js';

export interface MergeValidationResult {
  canMerge: boolean;
  issues: MergeIssue[];
  mainBranch: string;
  worktreeBranch: string;
}

export interface MergeIssue {
  type: 'main_dirty' | 'worktree_uncommitted' | 'merge_conflict' | 'nothing_to_merge';
  message: string;
  files?: string[];
  canAutoResolve: boolean;
}

export interface GitStatus {
  hasChanges: boolean;
  files: string[];
  summary: string;
}

export interface GitStatusOptions {
  ignoredRelativePaths?: string[];
}

const DMUX_HOOK_SCAFFOLD_PATHS = new Set([
  '.dmux-hooks',
  '.dmux-hooks/',
  '.dmux-hooks/AGENTS.md',
  '.dmux-hooks/CLAUDE.md',
  '.dmux-hooks/README.md',
  '.dmux-hooks/examples',
  '.dmux-hooks/examples/',
]);

const AGENT_STATE_SCAFFOLD_PATHS = new Set([
  '.claude',
  '.claude/',
  '.codex',
  '.codex/',
]);

function parseGitStatusLine(line: string): { statusCode: string; filename: string } {
  const trimmed = line.trimStart();
  const spaceIndex = trimmed.indexOf(' ');
  const filename = spaceIndex >= 0 ? trimmed.slice(spaceIndex + 1).trim() : trimmed;

  return {
    statusCode: line.slice(0, 2),
    filename,
  };
}

function normalizeGitStatusPath(filename: string): string {
  return normalizeLinkedRepoPath(filename.replace(/\\/g, '/'));
}

function isIgnoredWorkspacePath(
  filename: string,
  ignoredRelativePaths: readonly string[]
): boolean {
  if (ignoredRelativePaths.length === 0) {
    return false;
  }

  const normalizedFilename = normalizeGitStatusPath(filename);
  if (!normalizedFilename) {
    return false;
  }

  return ignoredRelativePaths.some((relativePath) => (
    normalizedFilename === relativePath
    || normalizedFilename.startsWith(`${relativePath}/`)
  ));
}

function getIgnoredRelativePaths(
  repoPath: string,
  options?: GitStatusOptions
): string[] {
  const metadataPaths = readWorktreeMetadata(repoPath)?.linkedRepoPaths ?? [];
  const explicitPaths = options?.ignoredRelativePaths ?? [];

  return normalizeLinkedRepoPathsArray([
    ...metadataPaths,
    ...explicitPaths,
  ]);
}

function shouldIgnoreGitStatusEntry(
  statusCode: string,
  filename: string,
  ignoredRelativePaths: readonly string[]
): boolean {
  if (
    filename === '.dmux'
    || filename === '.dmux/'
    || filename.startsWith('.dmux/')
  ) {
    return true;
  }

  if (isIgnoredWorkspacePath(filename, ignoredRelativePaths)) {
    return true;
  }

  if (statusCode !== '??') {
    return false;
  }

  return (
    AGENT_STATE_SCAFFOLD_PATHS.has(filename)
    || filename.startsWith('.claude/')
    || filename.startsWith('.codex/')
    || DMUX_HOOK_SCAFFOLD_PATHS.has(filename)
    || filename.startsWith('.dmux-hooks/examples/')
  );
}

/**
 * Get git status for a repository
 */
export function getGitStatus(repoPath: string, options: GitStatusOptions = {}): GitStatus {
  try {
    LogService.getInstance().info(`Getting git status for: ${repoPath}`, 'mergeValidation');
    const ignoredRelativePaths = getIgnoredRelativePaths(repoPath, options);
    const statusOutput = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const entries = statusOutput
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parsed = parseGitStatusLine(line);
        LogService.getInstance().info(
          `Git status: "${line}" → "${parsed.filename}"`,
          'mergeValidation'
        );
        return { line, ...parsed };
      });

    const visibleEntries = entries
      .filter(({ statusCode, filename, line }) => {
        const shouldIgnore = shouldIgnoreGitStatusEntry(
          statusCode,
          filename,
          ignoredRelativePaths
        );
        if (shouldIgnore) {
          LogService.getInstance().info(
            `Ignoring git status entry: "${line}"`,
            'mergeValidation'
          );
        }
        return !shouldIgnore;
      });

    const files = visibleEntries
      .map(({ filename }) => filename);

    LogService.getInstance().info(
      `Final files for ${repoPath}: ${JSON.stringify(files)}`,
      'mergeValidation'
    );

    return {
      hasChanges: files.length > 0,
      files,
      summary: visibleEntries.map(({ line }) => line).join('\n'),
    };
  } catch (error) {
    return {
      hasChanges: false,
      files: [],
      summary: '',
    };
  }
}

/**
 * Get current branch name
 */
export function getCurrentBranch(repoPath: string): string {
  return getCurrentBranchUtil(repoPath);
}

/**
 * Check if there are any commits to merge
 */
export function hasCommitsToMerge(repoPath: string, fromBranch: string, toBranch: string): boolean {
  try {
    const fromRef = fromBranch.trim() || 'HEAD';
    const toRef = toBranch.trim() || 'HEAD';

    const output = execSync(`git rev-list --count "${toRef}..${fromRef}"`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const commitCount = Number.parseInt(output.trim(), 10);
    return Number.isFinite(commitCount) && commitCount > 0;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    LogService.getInstance().warn(
      `Failed commit check for ${toBranch}..${fromBranch} in ${repoPath}: ${errorMsg}`,
      'mergeValidation'
    );
    return false;
  }
}

/**
 * Detect potential merge conflicts without actually merging
 */
export function detectMergeConflicts(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): { hasConflicts: boolean; conflictFiles: string[] } {
  try {
    // Use git merge-tree to simulate merge without touching working directory
    const output = execSync(
      `git merge-tree $(git merge-base ${targetBranch} ${sourceBranch}) ${targetBranch} ${sourceBranch}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    );

    // Check for conflict markers in output
    const hasConflicts = output.includes('<<<<<<<') || output.includes('>>>>>>>');

    // Extract conflicting files (lines that contain conflict markers)
    const conflictFiles: string[] = [];
    if (hasConflicts) {
      const lines = output.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('+<<<<<<<')) {
          // Try to find filename in nearby lines
          for (let j = Math.max(0, i - 10); j < i; j++) {
            if (lines[j].startsWith('diff --git')) {
              const match = lines[j].match(/b\/(.+)$/);
              if (match) {
                conflictFiles.push(match[1]);
              }
              break;
            }
          }
        }
      }
    }

    return { hasConflicts, conflictFiles };
  } catch (error) {
    // If git merge-tree fails, try a simpler approach
    try {
      // Check if branches have diverged (different commits)
      const diverged = execSync(
        `git rev-list --left-right --count ${targetBranch}...${sourceBranch}`,
        {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      );

      const [behind, ahead] = diverged.trim().split('\t').map(Number);

      // If both branches have commits (diverged), there might be conflicts
      // If only one side has commits, it's a fast-forward merge (no conflicts)
      if (behind > 0 && ahead > 0) {
        // Get list of changed files on both sides
        const changedFiles = execSync(
          `git diff --name-only ${targetBranch}...${sourceBranch}`,
          {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: 'pipe',
          }
        ).trim().split('\n').filter(Boolean);

        return { hasConflicts: true, conflictFiles: changedFiles };
      }

      // Fast-forward merge, no conflicts
      return { hasConflicts: false, conflictFiles: [] };
    } catch {
      // If everything fails, be conservative but don't claim conflicts
      return { hasConflicts: false, conflictFiles: [] };
    }
  }
}

/**
 * Comprehensive pre-merge validation
 */
export function validateMerge(
  mainRepoPath: string,
  worktreePath: string,
  worktreeBranch: string
): MergeValidationResult {
  const issues: MergeIssue[] = [];
  const linkedRepoPaths = readWorktreeMetadata(worktreePath)?.linkedRepoPaths ?? [];

  // Get current main branch
  const mainBranch = getCurrentBranch(mainRepoPath);

  // Check if main branch is clean
  const mainStatus = getGitStatus(mainRepoPath, {
    ignoredRelativePaths: linkedRepoPaths,
  });
  if (mainStatus.hasChanges) {
    issues.push({
      type: 'main_dirty',
      message: `Main branch (${mainBranch}) has uncommitted changes`,
      files: mainStatus.files,
      canAutoResolve: true, // Can offer to commit or stash
    });
  }

  // Check if worktree has uncommitted changes
  const worktreeStatus = getGitStatus(worktreePath, {
    ignoredRelativePaths: linkedRepoPaths,
  });
  LogService.getInstance().info(
    `Worktree status: hasChanges=${worktreeStatus.hasChanges}, files=${JSON.stringify(worktreeStatus.files)}`,
    'mergeValidation'
  );
  if (worktreeStatus.hasChanges) {
    issues.push({
      type: 'worktree_uncommitted',
      message: `Worktree has uncommitted changes`,
      files: worktreeStatus.files,
      canAutoResolve: true, // Can offer to commit with AI message
    });
  }

  // Check if there's anything to merge from the worktree perspective.
  // Main-repo uncommitted changes are handled by main_dirty and should not
  // also be classified as "nothing to merge" (which causes incorrect skips).
  const hasCommits = hasCommitsToMerge(mainRepoPath, worktreeBranch, mainBranch);
  LogService.getInstance().info(
    `Merge check: hasCommits=${hasCommits}, worktreeHasChanges=${worktreeStatus.hasChanges}`,
    'mergeValidation'
  );
  if (!hasCommits && !worktreeStatus.hasChanges && !mainStatus.hasChanges) {
    LogService.getInstance().info('Adding nothing_to_merge issue', 'mergeValidation');
    issues.push({
      type: 'nothing_to_merge',
      message: 'No new commits to merge',
      canAutoResolve: false,
    });
  }

  // Detect potential merge conflicts
  const { hasConflicts, conflictFiles } = detectMergeConflicts(
    mainRepoPath,
    worktreeBranch,
    mainBranch
  );

  if (hasConflicts) {
    issues.push({
      type: 'merge_conflict',
      message: 'Merge conflicts detected',
      files: conflictFiles.length > 0 ? conflictFiles : ['(conflict detection incomplete)'],
      canAutoResolve: true, // Can offer AI-assisted merge
    });
  }

  return {
    canMerge: issues.length === 0,
    issues,
    mainBranch,
    worktreeBranch,
  };
}

/**
 * Stage all uncommitted changes
 */
export function stageAllChanges(repoPath: string): { success: boolean; error?: string } {
  try {
    LogService.getInstance().info(`Staging all changes in: ${repoPath}`, 'stageAllChanges');

    execSync('git add -A', {
      cwd: repoPath,
      stdio: 'pipe',
    });

    // Check if anything was actually staged
    try {
      execSync('git diff --cached --quiet', {
        cwd: repoPath,
        stdio: 'pipe',
      });
      // If this succeeds, nothing is staged
      LogService.getInstance().warn(`No changes were staged in: ${repoPath}`, 'stageAllChanges');
    } catch {
      // Good - there are staged changes
      LogService.getInstance().info(`Changes staged successfully in: ${repoPath}`, 'stageAllChanges');
    }

    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    LogService.getInstance().error(`Failed to stage changes in ${repoPath}: ${errorMsg}`, 'stageAllChanges');
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Commit staged changes with a message
 */
export function commitChanges(
  repoPath: string,
  message: string
): { success: boolean; error?: string } {
  try {
    LogService.getInstance().info(`Committing changes in: ${repoPath}`, 'commitChanges');
    LogService.getInstance().info(`Commit message: ${message}`, 'commitChanges');

    // Check if there are staged changes before committing
    const stagedCheck = execSync('git diff --cached --quiet', {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (stagedError) {
    // git diff --cached --quiet exits with 1 if there ARE staged changes (which is good)
    // This is expected behavior - continue with commit
  }

  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    LogService.getInstance().info(`Commit successful in: ${repoPath}`, 'commitChanges');
    return { success: true };
  } catch (error: unknown) {
    // Try to get more detailed error info
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
      // execSync errors have stderr in the error object
      const execError = error as Error & { stderr?: Buffer | string };
      if (execError.stderr) {
        const stderr = typeof execError.stderr === 'string'
          ? execError.stderr
          : execError.stderr.toString();
        if (stderr.trim()) {
          errorMessage = stderr.trim();
        }
      }
    }
    LogService.getInstance().error(`Commit failed in ${repoPath}: ${errorMessage}`, 'commitChanges');
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Stash uncommitted changes
 */
export function stashChanges(repoPath: string): { success: boolean; error?: string } {
  try {
    execSync('git stash push -u -m "dmux: auto-stash before merge"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
