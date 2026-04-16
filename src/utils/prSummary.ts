/**
 * AI-generated pull request summary from branch diff
 */

import { execSync } from 'child_process';
import { callOpenRouter } from './aiMerge.js';
import { LogService } from '../services/LogService.js';

export interface PRSummary {
  title: string;
  body: string;
}

export interface BranchDiff {
  diff: string;
  summary: string;
  commitLog: string;
}

/**
 * List of file paths changed between target and source branch.
 */
export function getChangedFiles(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): string[] {
  try {
    const out = execSync(
      `git diff --name-only ${targetBranch}...${sourceBranch}`,
      { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    LogService.getInstance().warn(
      `getChangedFiles failed for ${sourceBranch}...${targetBranch}: ${error}`,
      'prSummary'
    );
    return [];
  }
}

/**
 * Get diff and metadata between source branch and target branch (target...source)
 */
export function getBranchDiff(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): BranchDiff {
  try {
    const diff = execSync(
      `git diff ${targetBranch}...${sourceBranch}`,
      { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
    );

    const summary = execSync(
      `git diff --stat ${targetBranch}...${sourceBranch}`,
      { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
    );

    const commitLog = execSync(
      `git log --pretty=format:%s ${targetBranch}..${sourceBranch}`,
      { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
    );

    return { diff, summary, commitLog };
  } catch (error) {
    LogService.getInstance().warn(
      `getBranchDiff failed for ${sourceBranch}...${targetBranch}: ${error}`,
      'prSummary'
    );
    return { diff: '', summary: '', commitLog: '' };
  }
}

/**
 * Format a PRSummary as the multi-line string we pre-fill the input popup with
 * (first line = title, blank line, rest = body)
 */
export function formatPRSummary(summary: PRSummary): string {
  const title = summary.title.trim();
  const body = summary.body.trim();
  if (!body) return title;
  return `${title}\n\n${body}`;
}

/**
 * Parse the user-edited single-string input back into title/body
 */
export function parsePRSummary(input: string): PRSummary {
  const trimmed = input.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return { title: '', body: '' };

  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) {
    return { title: trimmed, body: '' };
  }

  const title = trimmed.slice(0, firstBreak).trim();
  const body = trimmed.slice(firstBreak + 1).replace(/^\n+/, '').trim();
  return { title, body };
}

const PR_SYSTEM_PROMPT = `You write concise GitHub pull request descriptions from git diffs.

Respond with strict JSON: {"title": string, "body": string}.
- title: a single line, under 70 characters, in the style of a conventional commit or imperative mood summary. No trailing period.
- body: GitHub-flavored markdown. Include a "## Summary" section (2-4 bullets describing WHY and WHAT changed at a high level) and a "## Changes" section (bullets for notable code-level changes). Keep it under ~250 words. Do not fabricate tests or behavior that is not visible in the diff.

Output JSON only, no prose, no code fences.`;

/**
 * Generate a PR summary using the existing OpenRouter LLM. Returns null on failure.
 */
export async function generatePRSummary(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  timeoutMs: number = 20000
): Promise<PRSummary | null> {
  const { diff, summary, commitLog } = getBranchDiff(repoPath, sourceBranch, targetBranch);

  if (!diff.trim()) {
    return null;
  }

  const contextDiff = diff.length > 12000 ? diff.slice(0, 12000) + '\n...(truncated)' : diff;

  const userPrompt = `Source branch: ${sourceBranch}
Target branch: ${targetBranch}

Commit messages:
${commitLog || '(no commit messages)'}

File changes:
${summary}

Diff:
${contextDiff}

Return JSON with {"title","body"} describing this pull request.`;

  const prompt = `${PR_SYSTEM_PROMPT}\n\n${userPrompt}`;

  const raw = await callOpenRouter(prompt, 900, timeoutMs);
  if (!raw) return null;

  const parsed = extractJson(raw);
  if (!parsed) {
    LogService.getInstance().warn(
      `generatePRSummary: failed to parse JSON from LLM response`,
      'prSummary'
    );
    return null;
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';

  if (!title) return null;

  return { title, body };
}

function extractJson(raw: string): { title?: unknown; body?: unknown } | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
