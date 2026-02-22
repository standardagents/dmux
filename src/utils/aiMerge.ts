/**
 * AI-Assisted Merge Utilities
 *
 * Uses AI to help resolve merge conflicts intelligently
 */

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { LogService } from '../services/LogService.js';
import { callAgent } from './agentHarness.js';

/**
 * Get comprehensive git diff with context for commit message generation
 */
export function getComprehensiveDiff(repoPath: string): { diff: string; summary: string } {
  LogService.getInstance().info(`getComprehensiveDiff called for: ${repoPath}`, 'aiMerge');

  try {
    // Get staged changes first, then fall back to unstaged if nothing staged
    let diff = execSync('git diff --cached', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    let staged = true;
    LogService.getInstance().info(`git diff --cached length: ${diff.length}`, 'aiMerge');

    // If nothing staged, check unstaged changes
    if (!diff.trim()) {
      diff = execSync('git diff', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      staged = false;
      LogService.getInstance().info(`git diff (unstaged) length: ${diff.length}`, 'aiMerge');
    }

    // Get file summary
    const statusCmd = staged ? 'git diff --cached --stat' : 'git diff --stat';
    const summary = execSync(statusCmd, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    LogService.getInstance().info(`getComprehensiveDiff result - diff: ${diff.length} chars, summary: ${summary.trim().substring(0, 100)}`, 'aiMerge');
    return { diff, summary };
  } catch (error) {
    LogService.getInstance().error(`getComprehensiveDiff failed for ${repoPath}: ${error}`, 'aiMerge');
    return { diff: '', summary: '' };
  }
}

/**
 * Get AI-generated commit message from git diff
 * Returns null if generation fails, so caller can handle fallback
 */
export async function generateCommitMessage(repoPath: string): Promise<string | null> {
  try {
    const { diff, summary } = getComprehensiveDiff(repoPath);

    if (!diff.trim()) {
      return null; // No changes, let caller handle
    }

    // Include more context (up to 5000 chars) for better commit messages
    const contextDiff = diff.length > 5000 ? diff.slice(0, 5000) + '\n...(truncated)' : diff;

    const prompt = `Generate a concise conventional commit message (e.g., "feat: add feature", "fix: bug") for these changes. Respond with ONLY the commit message, nothing else:\n\nFile changes:\n${summary}\n\nDiff:\n${contextDiff}`;

    // Use sonnet for large diffs (>3000 chars), haiku for small ones
    const model = diff.length > 3000 ? 'mid' as const : 'cheap' as const;
    let message = await callAgent(prompt, { timeout: 60000, model });
    if (message) {
      message = message.replace(/^["']|["']$/g, '').trim();
      if (message && message.length < 100) {
        return message;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Read a file with conflict markers
 */
async function readConflictFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf-8');
}

/**
 * Parse conflict sections from a file
 */
interface ConflictSection {
  ours: string;
  theirs: string;
  base?: string;
}

function parseConflicts(content: string): ConflictSection[] {
  const sections: ConflictSection[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      let ours = '';
      let theirs = '';
      let base = '';

      i++;
      // Read "ours" section
      while (i < lines.length && !lines[i].startsWith('=======')) {
        ours += lines[i] + '\n';
        i++;
      }

      i++; // Skip =======
      // Read "theirs" section (or base if 3-way)
      while (i < lines.length && !lines[i].startsWith('>>>>>>>') && !lines[i].startsWith('|||||||')) {
        if (lines[i].startsWith('|||||||')) {
          break;
        }
        theirs += lines[i] + '\n';
        i++;
      }

      // Check for 3-way merge (with base)
      if (i < lines.length && lines[i].startsWith('|||||||')) {
        base = theirs;
        theirs = '';
        i++; // Skip |||||||
        while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
          theirs += lines[i] + '\n';
          i++;
        }
      }

      sections.push({
        ours: ours.trim(),
        theirs: theirs.trim(),
        base: base.trim() || undefined,
      });
    }
    i++;
  }

  return sections;
}

/**
 * Use AI to resolve a merge conflict
 */
export async function aiResolveConflict(
  filePath: string,
  repoPath: string
): Promise<{ success: boolean; resolvedContent?: string; error?: string }> {
  try {
    const fullPath = path.join(repoPath, filePath);
    const content = await readConflictFile(fullPath);
    const conflicts = parseConflicts(content);

    if (conflicts.length === 0) {
      return {
        success: true,
        resolvedContent: content,
      };
    }

    // For now, use a simple strategy: try to intelligently merge both versions
    const prompt = `You are resolving a git merge conflict. Below is a file with conflict markers.

Your task: Provide the COMPLETE resolved file content that intelligently combines both versions. Do NOT include any explanations, just the final file content.

File: ${filePath}

Conflict sections:
${conflicts
  .map(
    (c, i) => `
Conflict ${i + 1}:
<<<<<<< OURS (current branch)
${c.ours}
=======
>>>>>>> THEIRS (incoming branch)
${c.theirs}
`
  )
  .join('\n')}

Full file content:
${content}

Respond with ONLY the complete resolved file content, no explanations:`;

    let resolved = await callAgent(prompt, { timeout: 20000 });

    if (!resolved) {
      return {
        success: false,
        error: 'AI resolution unavailable',
      };
    }

    // Remove any markdown code fences if present
    resolved = resolved.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '');

    return {
      success: true,
      resolvedContent: resolved,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Resolve all conflicts in a repository using AI
 */
export async function aiResolveAllConflicts(
  repoPath: string,
  conflictFiles: string[]
): Promise<{ success: boolean; resolvedFiles: string[]; failedFiles: string[]; error?: string }> {
  const resolvedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const file of conflictFiles) {
    const result = await aiResolveConflict(file, repoPath);

    if (result.success && result.resolvedContent) {
      try {
        // Write resolved content
        await fs.writeFile(path.join(repoPath, file), result.resolvedContent, 'utf-8');

        // Stage the resolved file
        execSync(`git add "${file}"`, {
          cwd: repoPath,
          stdio: 'pipe',
        });

        resolvedFiles.push(file);
      } catch {
        failedFiles.push(file);
      }
    } else {
      failedFiles.push(file);
    }
  }

  return {
    success: failedFiles.length === 0,
    resolvedFiles,
    failedFiles,
    error: failedFiles.length > 0 ? `Failed to resolve: ${failedFiles.join(', ')}` : undefined,
  };
}
