import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { execAsync, execAsyncRace } from './execAsync.js';
import type { DmuxPane } from '../types.js';

/** Regex for characters allowed in git branch names and branch prefixes */
export const SAFE_BRANCH_CHARS = /^[a-zA-Z0-9._\/-]*$/;

/** Reject path traversal sequences */
const HAS_DOT_DOT = /\.\./;

/**
 * Get the git branch name for a pane.
 * Returns branchName if set (prefix-based), otherwise falls back to slug.
 */
export function getPaneBranchName(pane: DmuxPane): string {
  return pane.branchName || pane.slug;
}

/**
 * Checks whether a local branch exists in the repository.
 */
export function branchExists(repoPath: string, branchName: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet "refs/heads/${branchName}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is safe for use as a git branch name or prefix.
 * Returns true if valid, false if it contains dangerous characters.
 */
export function isValidBranchName(name: string): boolean {
  if (!name) return true; // empty is valid (means "not set")
  return SAFE_BRANCH_CHARS.test(name) && !HAS_DOT_DOT.test(name);
}

/**
 * Validate a complete branch name for create-time overrides.
 *
 * isValidBranchName intentionally accepts branch-prefix values such as "feat/".
 * Overrides must be complete refs because they are used directly in git worktree
 * commands and to derive a worktree directory.
 */
export function isValidFullBranchName(name: string): boolean {
  if (!isValidBranchName(name)) return false;
  if (!name) return false;
  if (name === '@' || name === '.') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.') || name.includes('//') || name.includes('@{')) return false;

  return name
    .split('/')
    .every((part) =>
      part.length > 0
      && part !== '.'
      && part !== '..'
      && !part.startsWith('.')
      && !part.endsWith('.lock')
    );
}

/**
 * Detects the main/master branch name for the repository (async version)
 * Uses Promise.any for efficient fallback - first successful result wins
 */
export async function getMainBranchAsync(): Promise<string> {
  // Try the most reliable method first
  try {
    const originHead = await execAsync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null', { silent: true });
    if (originHead) {
      const match = originHead.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Continue to fallbacks
  }

  // Race between checking main and master
  try {
    return await execAsyncRace([
      'git show-ref --verify --quiet refs/heads/main && echo main',
      'git show-ref --verify --quiet refs/heads/master && echo master',
    ]);
  } catch {
    // Neither exists, try current branch
  }

  try {
    const branches = await execAsync('git branch --list', { silent: true });
    const match = branches.match(/^\* (.+)$/m);
    if (match) {
      return match[1].trim();
    }
  } catch {
    // Failed to get any branch
  }

  return 'main'; // Default fallback
}

/**
 * Detects the main/master branch name for the repository
 * @deprecated Use getMainBranchAsync for non-blocking operation
 */
export function getMainBranch(): string {
  try {
    // First try to get the default branch from origin
    const originHead = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null', {
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();

    if (originHead) {
      // Extract branch name from refs/remotes/origin/main format
      const match = originHead.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Fallback if origin/HEAD is not set
  }

  try {
    // Check if 'main' branch exists
    execSync('git show-ref --verify --quiet refs/heads/main', { stdio: 'pipe' });
    return 'main';
  } catch {
    // main doesn't exist
  }

  try {
    // Check if 'master' branch exists
    execSync('git show-ref --verify --quiet refs/heads/master', { stdio: 'pipe' });
    return 'master';
  } catch {
    // master doesn't exist
  }

  // Last resort: get the initial branch
  try {
    const branches = execSync('git branch --list', { encoding: 'utf8', stdio: 'pipe' });
    const match = branches.match(/^\* (.+)$/m);
    if (match) {
      return match[1].trim();
    }
  } catch {
    // Failed to get any branch
  }

  return 'main'; // Default fallback
}

/**
 * Gets the current branch name (async version)
 */
export async function getCurrentBranchAsync(cwd?: string): Promise<string> {
  try {
    return await execAsync('git branch --show-current', { cwd, silent: true });
  } catch {
    return 'main';
  }
}

/**
 * Gets the current branch name
 * @deprecated Use getCurrentBranchAsync for non-blocking operation
 */
export function getCurrentBranch(cwd?: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return 'main';
  }
}

/**
 * Checks if there are uncommitted changes in the repository (async version)
 */
export async function hasUncommittedChangesAsync(cwd?: string): Promise<boolean> {
  try {
    const status = await execAsync('git status --porcelain', { cwd, silent: true });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Checks if there are uncommitted changes in the repository
 * @deprecated Use hasUncommittedChangesAsync for non-blocking operation
 */
export function hasUncommittedChanges(cwd?: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gets the list of conflicted files (async version)
 */
export async function getConflictedFilesAsync(cwd?: string): Promise<string[]> {
  try {
    const status = await execAsync('git status --porcelain', { cwd, silent: true });

    return status
      .split('\n')
      .filter(line => line.startsWith('UU ') || line.startsWith('AA '))
      .map(line => line.substring(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Gets the list of conflicted files
 * @deprecated Use getConflictedFilesAsync for non-blocking operation
 */
export function getConflictedFiles(cwd?: string): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe'
    });

    return status
      .split('\n')
      .filter(line => line.startsWith('UU ') || line.startsWith('AA '))
      .map(line => line.substring(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Represents an orphaned worktree (exists on filesystem but no active pane)
 */
export interface OrphanedWorktree {
  slug: string;
  path: string;
  lastModified: Date;
  branch: string;
  hasUncommittedChanges: boolean;
}

/**
 * Gets a list of orphaned worktrees (async version)
 * Uses parallel operations for better performance with many worktrees
 */
export async function getOrphanedWorktreesAsync(
  projectRoot: string,
  activePaneSlugs: string[]
): Promise<OrphanedWorktree[]> {
  const worktreesDir = path.join(projectRoot, '.dmux', 'worktrees');

  try {
    await fsPromises.access(worktreesDir);
  } catch {
    return [];
  }

  const orphaned: OrphanedWorktree[] = [];

  try {
    const entries = await fsPromises.readdir(worktreesDir, { withFileTypes: true });

    // Process worktrees in parallel for better performance
    const worktreePromises = entries
      .filter(entry => entry.isDirectory() && !activePaneSlugs.includes(entry.name))
      .map(async (entry) => {
        const slug = entry.name;
        const worktreePath = path.join(worktreesDir, slug);
        const gitFile = path.join(worktreePath, '.git');

        // Check if it's a valid git worktree
        try {
          await fsPromises.access(gitFile);
        } catch {
          return null;
        }

        // Get last modified time
        let lastModified = new Date(0);
        try {
          const [stats, gitStats] = await Promise.all([
            fsPromises.stat(worktreePath),
            fsPromises.stat(gitFile)
          ]);
          lastModified = stats.mtime > gitStats.mtime ? stats.mtime : gitStats.mtime;
        } catch {
          // Use default date if stat fails
        }

        // Get branch name and check for changes in parallel
        const [branch, hasChanges] = await Promise.all([
          getCurrentBranchAsync(worktreePath).then(b => b || slug),
          hasUncommittedChangesAsync(worktreePath)
        ]);

        return {
          slug,
          path: worktreePath,
          lastModified,
          branch,
          hasUncommittedChanges: hasChanges,
        };
      });

    const results = await Promise.all(worktreePromises);
    orphaned.push(...results.filter((r): r is OrphanedWorktree => r !== null));

    // Sort by most recently modified first
    orphaned.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  } catch {
    // Return empty array if directory read fails
  }

  return orphaned;
}

/**
 * Gets a list of orphaned worktrees - worktrees that exist in .dmux/worktrees
 * but don't have an active pane tracking them
 * @deprecated Use getOrphanedWorktreesAsync for non-blocking operation
 */
export function getOrphanedWorktrees(
  projectRoot: string,
  activePaneSlugs: string[]
): OrphanedWorktree[] {
  const worktreesDir = path.join(projectRoot, '.dmux', 'worktrees');

  if (!fs.existsSync(worktreesDir)) {
    return [];
  }

  const orphaned: OrphanedWorktree[] = [];

  try {
    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const slug = entry.name;
      const worktreePath = path.join(worktreesDir, slug);

      // Skip if this worktree has an active pane
      if (activePaneSlugs.includes(slug)) continue;

      // Check if it's a valid git worktree
      const gitFile = path.join(worktreePath, '.git');
      if (!fs.existsSync(gitFile)) continue;

      // Get last modified time (use most recent mtime from key files)
      let lastModified = new Date(0);
      try {
        const stats = fs.statSync(worktreePath);
        lastModified = stats.mtime;

        // Also check .git file modification time as a proxy for last activity
        const gitStats = fs.statSync(gitFile);
        if (gitStats.mtime > lastModified) {
          lastModified = gitStats.mtime;
        }
      } catch {
        // Use default date if stat fails
      }

      // Get the branch name
      let branch = slug; // Default to slug
      try {
        branch = execSync('git branch --show-current', {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim() || slug;
      } catch {
        // Use slug as fallback
      }

      // Check for uncommitted changes
      const hasChanges = hasUncommittedChanges(worktreePath);

      orphaned.push({
        slug,
        path: worktreePath,
        lastModified,
        branch,
        hasUncommittedChanges: hasChanges,
      });
    }

    // Sort by most recently modified first
    orphaned.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  } catch {
    // Return empty array if directory read fails
  }

  return orphaned;
}
