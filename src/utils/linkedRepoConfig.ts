import fs from 'fs';
import path from 'path';

export interface LinkedRepoReference {
  relativePath: string;
  repoPath: string;
}

const LINKED_REPO_SPLIT_PATTERN = /[\n,]+/;
const LINKED_REPO_DISCOVERY_EXCLUDED_DIRS = new Set([
  '.dmux',
  '.git',
  '.next',
  '.pnpm',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

export function normalizeLinkedRepoPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

export function normalizeLinkedRepoPathsArray(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const normalizedValue = normalizeLinkedRepoPath(value);
    if (!normalizedValue || seen.has(normalizedValue)) {
      continue;
    }
    seen.add(normalizedValue);
    normalized.push(normalizedValue);
  }

  return normalized;
}

export function parseLinkedRepoPathsInput(value?: string | null): string[] {
  if (!value) {
    return [];
  }

  return normalizeLinkedRepoPathsArray(value.split(LINKED_REPO_SPLIT_PATTERN));
}

export function validateLinkedRepoPathsSetting(value?: string | null): string[] {
  const parsed = parseLinkedRepoPathsInput(value);

  for (const relativePath of parsed) {
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Invalid linkedRepoPaths entry: "${relativePath}" must be relative to the project root`);
    }
    if (
      relativePath === '.'
      || relativePath === '..'
      || relativePath.startsWith('../')
      || relativePath.includes('/../')
    ) {
      throw new Error(`Invalid linkedRepoPaths entry: "${relativePath}" cannot escape the project root`);
    }
  }

  return parsed;
}

export function normalizeLinkedRepoPathsSetting(value?: string | null): string | undefined {
  const parsed = validateLinkedRepoPathsSetting(value);
  return parsed.length > 0 ? parsed.join('\n') : undefined;
}

export function resolveLinkedRepoReferences(
  projectRoot: string,
  linkedRepoPaths?: string[] | string | null
): LinkedRepoReference[] {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const parsed = Array.isArray(linkedRepoPaths)
    ? normalizeLinkedRepoPathsArray(linkedRepoPaths)
    : validateLinkedRepoPathsSetting(linkedRepoPaths);

  return parsed.map((relativePath) => {
    const repoPath = path.resolve(resolvedProjectRoot, relativePath);
    const relativeToRoot = path.relative(resolvedProjectRoot, repoPath);

    if (
      relativeToRoot === ''
      || relativeToRoot === '.'
      || relativeToRoot === '..'
      || relativeToRoot.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Linked repo path must point to a child repository: ${relativePath}`);
    }

    if (!fs.existsSync(repoPath)) {
      throw new Error(`Linked repo path does not exist: ${relativePath}`);
    }

    const gitPath = path.join(repoPath, '.git');
    if (!fs.existsSync(gitPath)) {
      throw new Error(`Linked repo path is not a git repository: ${relativePath}`);
    }

    return {
      relativePath,
      repoPath,
    };
  });
}

function isGitRepoRoot(dirPath: string): boolean {
  const gitPath = path.join(dirPath, '.git');
  if (!fs.existsSync(gitPath)) {
    return false;
  }

  try {
    const stat = fs.statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function discoverLinkedRepoPaths(projectRoot: string): string[] {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const discovered = new Set<string>();

  const walk = (dirPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (LINKED_REPO_DISCOVERY_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (isGitRepoRoot(fullPath)) {
        const relativePath = normalizeLinkedRepoPath(
          path.relative(resolvedProjectRoot, fullPath)
        );
        if (relativePath && relativePath !== '.') {
          discovered.add(relativePath);
        }
      }

      walk(fullPath);
    }
  };

  walk(resolvedProjectRoot);

  return Array.from(discovered).sort((left, right) => left.localeCompare(right));
}
