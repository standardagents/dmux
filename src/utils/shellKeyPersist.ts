import fs from 'fs/promises';
import os from 'os';
import path from 'path';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForFish(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
  return `"${escaped}"`;
}

function isFishShell(shellPath?: string): boolean {
  return path.basename(shellPath || '').toLowerCase().includes('fish');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function blockMarkers(key: string): { start: string; end: string } {
  const tag = key.toLowerCase().replace(/_/g, '-');
  return {
    start: `# >>> dmux ${tag} >>>`,
    end: `# <<< dmux ${tag} <<<`,
  };
}

export function getShellConfigCandidates(shellPath: string | undefined, homeDir: string): string[] {
  const shellName = path.basename(shellPath || '').toLowerCase();

  if (shellName.includes('zsh')) {
    return [
      path.join(homeDir, '.zshrc'),
      path.join(homeDir, '.zprofile'),
    ];
  }

  if (shellName.includes('bash')) {
    return [
      path.join(homeDir, '.bashrc'),
      path.join(homeDir, '.bash_profile'),
      path.join(homeDir, '.profile'),
    ];
  }

  if (shellName.includes('fish')) {
    return [
      path.join(homeDir, '.config', 'fish', 'config.fish'),
    ];
  }

  return [path.join(homeDir, '.profile')];
}

export async function resolveShellConfigPath(shellPath: string | undefined, homeDir: string): Promise<string> {
  const candidates = getShellConfigCandidates(shellPath, homeDir);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function buildExportLine(key: string, value: string, shellPath?: string): string {
  const trimmedValue = value.trim();
  if (isFishShell(shellPath)) {
    return `set -gx ${key} ${quoteForFish(trimmedValue)}`;
  }
  return `export ${key}=${quoteForPosix(trimmedValue)}`;
}

export function upsertEnvBlock(existingContent: string, key: string, exportLine: string): string {
  const { start, end } = blockMarkers(key);
  const normalizedContent = existingContent.replace(/\r\n/g, '\n');
  const block = `${start}\n${exportLine}\n${end}`;
  const blockPattern = new RegExp(
    `${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
    'm'
  );

  if (blockPattern.test(normalizedContent)) {
    const replaced = normalizedContent.replace(blockPattern, `${block}\n`);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }

  if (!normalizedContent) {
    return `${block}\n`;
  }

  const withTrailingNewline = normalizedContent.endsWith('\n')
    ? normalizedContent
    : `${normalizedContent}\n`;

  return `${withTrailingNewline}\n${block}\n`;
}

export async function persistEnvToShell(
  key: string,
  value: string,
  options?: { shellPath?: string; homeDir?: string }
): Promise<{ shellConfigPath: string; exportLine: string }> {
  const homeDir = options?.homeDir || process.env.HOME || os.homedir();
  if (!homeDir) {
    throw new Error('Unable to determine HOME directory');
  }

  const shellPath = options?.shellPath || process.env.SHELL;
  const shellConfigPath = await resolveShellConfigPath(shellPath, homeDir);

  let existingContent = '';
  try {
    existingContent = await fs.readFile(shellConfigPath, 'utf-8');
  } catch {
    // Expected if shell config does not exist yet
  }

  const exportLine = buildExportLine(key, value, shellPath);
  const updatedContent = upsertEnvBlock(existingContent, key, exportLine);

  await fs.mkdir(path.dirname(shellConfigPath), { recursive: true });
  await fs.writeFile(shellConfigPath, updatedContent, 'utf-8');

  return { shellConfigPath, exportLine };
}
