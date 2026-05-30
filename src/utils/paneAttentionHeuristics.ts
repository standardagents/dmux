import type { AgentName } from './agentLaunch.js';

export type AgentHookStatus = 'idle' | 'waiting' | 'working';

const GENERIC_PROGRESS_WORDS = [
  'working',
  'thinking',
  'planning',
  'pondering',
  'crunching',
  'analyzing',
  'building',
  'testing',
  'running',
  'searching',
  'reviewing',
  'understanding',
  'loading',
  'processing',
  'writing',
  'reading',
  'editing',
  'patching',
  'generating',
  'reasoning',
  'compiling',
  'indexing',
  'summarizing',
  'executing',
  'refactoring',
  'fixing',
  'checking',
  'scanning',
];

const SPINNER_PREFIX = '[⠁-⣿◐◓◑◒◴◷◶◵●○◦•·⋯⋮✦✧✶✻✽⏳⌛]';
const PROMPT_PATTERNS = [
  /^\s*>\s*\S/,
  /^\s*\$\s*\S/,
  /^\s*❯\s*\S/,
  /^\s*›\s*\S/,
  /^\s*│\s*>\s*\S/,
  /^\s*│\s*\$\s*\S/,
  /^\s*│\s*❯\s*\S/,
  /^\s*│\s*›\s*\S/,
  /^\s*>\s*$/,
  /^\s*\$\s*$/,
  /^\s*❯\s*$/,
  /^\s*›\s*$/,
  /^\s*│\s*>\s*$/,
  /^\s*│\s*\$\s*$/,
  /^\s*│\s*❯\s*$/,
  /^\s*│\s*›\s*$/,
];
const PROMPT_CONTINUATION_PATTERNS = [
  /^\s{2,}\S/,
  /^\s*│\s{2,}\S/,
];

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function getAgentHookStatus(event: unknown): AgentHookStatus | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const record = event as Record<string, unknown>;
  const explicitStatus = stringField(record.dmuxStatus);
  if (explicitStatus === 'idle' || explicitStatus === 'waiting' || explicitStatus === 'working') {
    return explicitStatus;
  }

  const hookEventName = stringField(record.hookEventName)
    || stringField(record.hook_event_name);

  if (!hookEventName) {
    return 'idle';
  }

  switch (hookEventName) {
    case 'Stop':
    case 'SubagentStop':
      return 'idle';
    case 'Notification':
    case 'PermissionRequest':
      return 'waiting';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';
    default:
      return null;
  }
}

function trimSurroundingEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }

  return lines.slice(start, end);
}

function recentRelevantLines(content: string, maxLines: number = 8): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;
  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function looksLikePromptLine(line: string): boolean {
  return PROMPT_PATTERNS.some((pattern) => pattern.test(line));
}

function looksLikePromptContinuationLine(line: string): boolean {
  return PROMPT_CONTINUATION_PATTERNS.some((pattern) => pattern.test(line));
}

function normalizeLinesForComparison(lines: string[]): string {
  return trimSurroundingEmptyLines(lines)
    .map((line) => line.trimEnd())
    .join('\n');
}

function normalizePromptBlock(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^\s*│\s*/, ''))
    .map((line) => line.replace(/^(?:[>$❯›])\s?/, ''))
    .map((line) => line.replace(/^\s{2,}/, ''))
    .map((line) => line.trimEnd())
    .join('\n');
}

function extractTrailingPromptBlock(
  content: string
): { prefixLines: string[]; promptLines: string[] } | null {
  const lines = trimSurroundingEmptyLines(content.split('\n'));
  if (lines.length === 0) {
    return null;
  }

  const searchStart = Math.max(0, lines.length - 12);
  for (let index = lines.length - 1; index >= searchStart; index -= 1) {
    if (!looksLikePromptLine(lines[index])) {
      continue;
    }

    const trailingLines = lines.slice(index + 1);
    if (trailingLines.every((line) => looksLikePromptContinuationLine(line))) {
      return {
        prefixLines: lines.slice(0, index),
        promptLines: lines.slice(index),
      };
    }
  }

  return null;
}

export function buildPaneActivityFingerprint(
  content: string,
  maxLines: number = 12
): string {
  const lines = trimSurroundingEmptyLines(content.split('\n'));
  if (lines.length === 0) {
    return '';
  }

  return lines
    .slice(-maxLines)
    .map((line) => line.trimEnd())
    .join('\n');
}

export function hasAgentWorkingIndicators(content: string, agent?: AgentName): boolean {
  const lines = recentRelevantLines(content, 10);
  if (lines.length === 0) {
    return false;
  }

  const recentContent = lines.join('\n');
  if (/\besc\s+to\s+(interrupt|cancel|stop|abort)\b/i.test(recentContent)) {
    return true;
  }

  const progressWordPattern = new RegExp(
    `(?:${GENERIC_PROGRESS_WORDS.join('|')})(?:\\b|\\.\\.\\.|…|\\s)`,
    'i'
  );
  const spinnerLinePattern = new RegExp(
    `^${SPINNER_PREFIX}\\s*(?:${GENERIC_PROGRESS_WORDS.join('|')})(?:\\b|\\.\\.\\.|…|\\s)`,
    'i'
  );
  const progressSuffixPattern = new RegExp(
    `\\b(?:${GENERIC_PROGRESS_WORDS.join('|')})\\b.*(?:\\.\\.\\.|…|\\d{1,3}%|/\\d+)`,
    'i'
  );

  if (lines.some((line) => spinnerLinePattern.test(line) || progressSuffixPattern.test(line))) {
    return true;
  }

  switch (agent) {
    case 'claude':
      return lines.some((line) =>
        /claude\s+is\s+working/i.test(line)
        || /(?:germinating|thinking|planning|writing|reading|analyzing|building|testing|running|searching|reviewing|understanding)[.…]*$/i.test(line)
        || progressWordPattern.test(line)
      );
    case 'opencode':
    case 'codex':
    case 'grok':
    case 'gemini':
    case 'qwen':
    case 'cursor':
    case 'copilot':
    case 'cline':
    case 'amp':
    case 'pi':
    case 'crush':
    case 'antigravity':
      return lines.some((line) => progressWordPattern.test(line));
    default:
      return lines.some((line) => progressWordPattern.test(line));
  }
}

export function isLikelyUserTyping(previousContent: string, currentContent: string): boolean {
  if (!currentContent || previousContent === currentContent) {
    return false;
  }

  const previousPromptBlock = extractTrailingPromptBlock(previousContent);
  const currentPromptBlock = extractTrailingPromptBlock(currentContent);
  if (previousPromptBlock || currentPromptBlock) {
    const previousPrefix = normalizeLinesForComparison(
      previousPromptBlock ? previousPromptBlock.prefixLines : previousContent.split('\n')
    );
    const currentPrefix = normalizeLinesForComparison(
      currentPromptBlock ? currentPromptBlock.prefixLines : currentContent.split('\n')
    );

    if (previousPrefix === currentPrefix) {
      const previousPrompt = normalizePromptBlock(previousPromptBlock?.promptLines || []);
      const currentPrompt = normalizePromptBlock(currentPromptBlock?.promptLines || []);
      if (previousPrompt !== currentPrompt) {
        return true;
      }
    }
  }

  const previousLines = previousContent.split('\n');
  const currentLines = currentContent.split('\n');
  if (Math.abs(currentLines.length - previousLines.length) > 6) {
    return false;
  }

  const maxLength = Math.max(previousLines.length, currentLines.length);
  const changedIndices: number[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    if ((previousLines[index] || '') !== (currentLines[index] || '')) {
      changedIndices.push(index);
    }
  }

  if (changedIndices.length === 0 || changedIndices.length > 6) {
    return false;
  }

  const bottomThreshold = maxLength - 6;
  if (changedIndices.some((index) => index < bottomThreshold)) {
    return false;
  }

  return changedIndices.some((index) => {
    const previousLine = previousLines[index] || '';
    const currentLine = currentLines[index] || '';
    const prefixLength = commonPrefixLength(previousLine, currentLine);
    const maxLengthForLine = Math.max(previousLine.length, currentLine.length);
    const mostlySharedPrefix = maxLengthForLine > 0 && prefixLength / maxLengthForLine >= 0.7;
    const promptLike = looksLikePromptLine(currentLine || previousLine)
      || looksLikePromptContinuationLine(currentLine || previousLine);

    if (
      (currentLine.startsWith(previousLine) || previousLine.startsWith(currentLine))
      && promptLike
    ) {
      return true;
    }

    return mostlySharedPrefix && promptLike;
  });
}
