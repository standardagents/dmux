#!/usr/bin/env node

/**
 * Dedicated popup for reviewing an AI-generated PR summary.
 * - Editable summary (title on first line, blank, markdown body) — scrollable
 * - Changed files list — navigable with arrow keys
 * - Per-file diff peek — Enter opens, arrows/PgUp/PgDn scroll, ESC/Space/Enter closes
 *
 * Modes: summary | files | diff. Tab toggles summary <-> files.
 * Ctrl+S submits, ESC cancels (from summary/files; from diff it returns to files).
 */

import React, { useMemo, useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  PopupContainer,
  PopupWrapper,
  writeSuccessAndExit,
  writeCancelAndExit,
} from './shared/index.js';
import CleanTextInput from '../inputs/CleanTextInput.js';
import { POPUP_CONFIG } from './config.js';

interface PRReviewPopupData {
  title: string;
  message: string;
  defaultValue: string;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  files: string[];
  aiFailed?: boolean;
}

interface Props {
  resultFile: string;
  data: PRReviewPopupData;
}

const DIFF_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DIFF_SCROLL_PAGE = 10;
const MAX_VISIBLE_FILES = 7;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getDiffText(data: PRReviewPopupData, file: string): string {
  const fileArg = shellEscape(file);
  const base = shellEscape(data.targetBranch);
  const head = shellEscape(data.sourceBranch);
  try {
    const output = execSync(
      `git --no-pager diff --no-color ${base}...${head} -- ${fileArg}`,
      {
        cwd: data.repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: DIFF_MAX_BUFFER_BYTES,
      }
    );
    if (output.trim().length > 0) return output;
    return `No diff output for ${file}.`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Failed to load diff for ${file}: ${msg}`;
  }
}

function getDiffLineColor(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'yellow';
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return POPUP_CONFIG.titleColor;
  return 'white';
}

function getVisibleWindow<T>(items: T[], idx: number, max: number) {
  const total = items.length;
  if (total <= max) return { start: 0, end: total };
  const centered = idx - Math.floor(max / 2);
  const start = Math.max(0, Math.min(centered, total - max));
  return { start, end: start + max };
}

const PRReviewPopupApp: React.FC<Props> = ({ resultFile, data }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [value, setValue] = useState(data.defaultValue);
  const [mode, setMode] = useState<'summary' | 'files' | 'diff'>('summary');
  const [fileIndex, setFileIndex] = useState(0);
  const [diff, setDiff] = useState<{ lines: string[]; offset: number; filePath: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const terminalRows = stdout?.rows || process.stdout.rows || 40;

  // Layout budgets — approximate, clamp to sane ranges.
  const summaryMaxVisibleLines = Math.max(6, Math.min(16, Math.floor(terminalRows * 0.42)));
  const diffMaxVisible = Math.max(10, terminalRows - 10);

  const fileWindow = useMemo(
    () => getVisibleWindow(data.files, fileIndex, MAX_VISIBLE_FILES),
    [data.files, fileIndex]
  );

  const openDiff = () => {
    const file = data.files[fileIndex];
    if (!file) return;
    const text = getDiffText(data, file);
    const lines = text.split('\n');
    setDiff({
      lines: lines.length > 0 ? lines : ['(empty)'],
      offset: 0,
      filePath: file,
    });
    setMode('diff');
  };

  const submit = () => {
    const trimmed = value.replace(/\r\n/g, '\n').trim();
    if (!trimmed) {
      setSubmitError('Title cannot be empty');
      setMode('summary');
      return;
    }
    writeSuccessAndExit(resultFile, value, exit);
  };

  useInput((input, key) => {
    if (mode === 'diff') {
      if (!diff) return;
      const maxOffset = Math.max(0, diff.lines.length - diffMaxVisible);
      if (key.upArrow) {
        setDiff({ ...diff, offset: Math.max(0, diff.offset - 1) });
        return;
      }
      if (key.downArrow) {
        setDiff({ ...diff, offset: Math.min(maxOffset, diff.offset + 1) });
        return;
      }
      if (key.pageUp) {
        setDiff({ ...diff, offset: Math.max(0, diff.offset - DIFF_SCROLL_PAGE) });
        return;
      }
      if (key.pageDown) {
        setDiff({ ...diff, offset: Math.min(maxOffset, diff.offset + DIFF_SCROLL_PAGE) });
        return;
      }
      if (key.escape || key.return || input === ' ') {
        setDiff(null);
        setMode('files');
        return;
      }
      return;
    }

    // Ctrl+S or Ctrl+D submits from either edit mode.
    if (key.ctrl && (input === 's' || input === 'd')) {
      submit();
      return;
    }

    if (mode === 'files') {
      if (key.escape) {
        setMode('summary');
        return;
      }
      if (key.tab) {
        setMode('summary');
        return;
      }
      if (key.upArrow) {
        setFileIndex((p) => Math.max(0, p - 1));
        return;
      }
      if (key.downArrow) {
        setFileIndex((p) => Math.min(Math.max(0, data.files.length - 1), p + 1));
        return;
      }
      if (key.return || input === ' ') {
        openDiff();
        return;
      }
      return;
    }

    // mode === 'summary'
    if (key.tab) {
      if (data.files.length > 0) {
        setMode('files');
      }
      return;
    }
    // Everything else passes through to CleanTextInput.
  });

  if (mode === 'diff' && diff) {
    const visible = diff.lines.slice(diff.offset, diff.offset + diffMaxVisible);
    const end = Math.min(diff.offset + diffMaxVisible, diff.lines.length);
    return (
      <PopupWrapper resultFile={resultFile} allowEscapeToCancel={false}>
        <PopupContainer footer="↑↓ scroll • PgUp/PgDn • Enter/Space/ESC back">
          <Box marginBottom={1} flexDirection="column">
            <Text bold color={POPUP_CONFIG.titleColor} wrap="truncate-end">{diff.filePath}</Text>
            <Text dimColor>
              {data.sourceBranch} vs {data.targetBranch} • Lines {Math.min(diff.offset + 1, diff.lines.length)}-{end} of {diff.lines.length}
            </Text>
          </Box>
          <Box flexDirection="column">
            {visible.map((line, i) => (
              <Text key={`${diff.offset + i}`} color={getDiffLineColor(line)} wrap="truncate-end">
                {line.length > 0 ? line : ' '}
              </Text>
            ))}
          </Box>
        </PopupContainer>
      </PopupWrapper>
    );
  }

  const footer = mode === 'summary'
    ? 'Edit summary • Tab → files • Ctrl+S submit • ESC cancel'
    : '↑↓ file • Enter peek diff • Tab ← summary • Ctrl+S submit • ESC ← summary';

  // When focus is on the file list, block popup-level ESC so ESC returns to summary instead.
  const allowEscapeToCancel = mode === 'summary';

  const summaryActive = mode === 'summary';
  const filesActive = mode === 'files';

  const hasFilesAbove = fileWindow.start > 0;
  const hasFilesBelow = fileWindow.end < data.files.length;

  return (
    <PopupWrapper resultFile={resultFile} allowEscapeToCancel={allowEscapeToCancel}>
      <PopupContainer footer={footer}>
        <Box marginBottom={0}>
          <Text bold color={POPUP_CONFIG.titleColor}>PR Title &amp; Description</Text>
        </Box>
        {data.message ? (
          <Box marginBottom={1} flexDirection="column">
            {data.message.split('\n').slice(0, 2).map((line, idx) => (
              <Text key={idx} dimColor wrap="truncate-end">{line}</Text>
            ))}
          </Box>
        ) : null}
        {submitError ? (
          <Box marginBottom={1}>
            <Text color={POPUP_CONFIG.errorColor}>{submitError}</Text>
          </Box>
        ) : null}

        <Box
          borderStyle="bold"
          borderColor={summaryActive ? POPUP_CONFIG.titleColor : 'gray'}
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <CleanTextInput
            value={value}
            onChange={setValue}
            placeholder={'feat: short title\n\n## Summary\n- ...'}
            ignoreFocus
            disableEscape
            maxVisibleLines={summaryMaxVisibleLines}
            disabled={!summaryActive}
          />
        </Box>

        <Box>
          <Text bold color={POPUP_CONFIG.titleColor}>
            Changed Files ({data.files.length})
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor={filesActive ? POPUP_CONFIG.titleColor : 'gray'}
          paddingX={1}
          flexDirection="column"
        >
          {hasFilesAbove ? <Text dimColor>↑ more above</Text> : null}
          {data.files.length === 0 ? (
            <Text dimColor>No files changed against {data.targetBranch}.</Text>
          ) : (
            data.files.slice(fileWindow.start, fileWindow.end).map((f, i) => {
              const actualIdx = fileWindow.start + i;
              const isSelected = actualIdx === fileIndex && filesActive;
              const isCursor = actualIdx === fileIndex && !filesActive;
              return (
                <Text
                  key={`${f}-${actualIdx}`}
                  color={isSelected ? POPUP_CONFIG.successColor : 'white'}
                  bold={isSelected}
                  dimColor={!filesActive && !isCursor}
                  wrap="truncate-end"
                >
                  {isSelected ? '▶ ' : '  '}{f}
                </Text>
              );
            })
          )}
          {hasFilesBelow ? <Text dimColor>↓ more below</Text> : null}
        </Box>
      </PopupContainer>
    </PopupWrapper>
  );
};

function main() {
  const resultFile = process.argv[2];
  const dataFile = process.argv[3];
  if (!resultFile || !dataFile) {
    console.error('Error: Result file and data file required');
    process.exit(1);
  }
  let data: PRReviewPopupData;
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as Partial<PRReviewPopupData>;
    data = {
      title: parsed.title || 'Pull Request',
      message: parsed.message || '',
      defaultValue: parsed.defaultValue || '',
      repoPath: parsed.repoPath || process.cwd(),
      sourceBranch: parsed.sourceBranch || 'HEAD',
      targetBranch: parsed.targetBranch || 'main',
      files: Array.isArray(parsed.files)
        ? parsed.files.filter((f): f is string => typeof f === 'string')
        : [],
      aiFailed: parsed.aiFailed === true,
    };
  } catch {
    console.error('Error: Failed to read or parse pr review popup data');
    process.exit(1);
  }

  render(<PRReviewPopupApp resultFile={resultFile} data={data} />);
}

main();
