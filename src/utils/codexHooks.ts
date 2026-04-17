import * as fs from 'fs';
import path from 'path';
import { atomicWriteFileSync, atomicWriteJsonSync } from './atomicWrite.js';
import { shellQuote } from './promptStore.js';

export interface CodexHookInstallResult {
  eventFile: string;
}

type ShellAssignment = [key: string, value: string];

function escapeForSingleQuotedJs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function mergeDmuxStopHook(hooksPath: string, hookCommand: string): void {
  let hooksConfig: any = {};
  if (fs.existsSync(hooksPath)) {
    try {
      hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    } catch {
      hooksConfig = {};
    }
  }

  if (!hooksConfig || typeof hooksConfig !== 'object' || Array.isArray(hooksConfig)) {
    hooksConfig = {};
  }

  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object' || Array.isArray(hooksConfig.hooks)) {
    hooksConfig.hooks = {};
  }

  const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
  const nextStopHooks = stopHooks.filter((group: any) => {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    return !handlers.some((handler: any) => (
      typeof handler?.command === 'string'
      && handler.command.includes('dmux-stop-hook.cjs')
    ));
  });
  nextStopHooks.push({
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        timeout: 5,
        statusMessage: 'Notifying dmux',
      },
    ],
  });

  hooksConfig.hooks.Stop = nextStopHooks;
  atomicWriteJsonSync(hooksPath, hooksConfig);
}

export function installCodexPaneHooks(opts: {
  worktreePath: string;
  dmuxPaneId: string;
  tmuxPaneId: string;
}): CodexHookInstallResult {
  const codexDir = path.join(opts.worktreePath, '.codex');
  const hookDir = path.join(codexDir, 'hooks');
  const stateDir = path.join(codexDir, 'dmux');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const eventFile = path.join(stateDir, `${opts.dmuxPaneId}.json`);
  const hookScriptPath = path.join(hookDir, 'dmux-stop-hook.cjs');
  const hookScript = `#!/usr/bin/env node
const fs = require('fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = input.trim() ? JSON.parse(input) : {};
  } catch (error) {
    payload = { parse_error: String(error), raw: input };
  }

  const event = {
    source: 'codex-stop-hook',
    dmuxPaneId: process.env.DMUX_PANE_ID || '',
    tmuxPaneId: process.env.DMUX_TMUX_PANE_ID || '',
    expectedDmuxPaneId: '${escapeForSingleQuotedJs(opts.dmuxPaneId)}',
    expectedTmuxPaneId: '${escapeForSingleQuotedJs(opts.tmuxPaneId)}',
    hookEventName: payload.hook_event_name || payload.hookEventName || '',
    turnId: payload.turn_id || payload.turnId || '',
    lastAssistantMessage: payload.last_assistant_message || null,
    transcriptPath: payload.transcript_path || null,
    cwd: payload.cwd || process.cwd(),
    timestamp: Date.now()
  };

  if (event.hookEventName && event.hookEventName !== 'Stop') {
    process.exit(0);
  }

  if (event.dmuxPaneId !== event.expectedDmuxPaneId) {
    process.exit(0);
  }

  try {
    fs.writeFileSync('${escapeForSingleQuotedJs(eventFile)}', JSON.stringify(event, null, 2));
  } catch (error) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ continue: true }));
});
`;
  atomicWriteFileSync(hookScriptPath, hookScript);
  fs.chmodSync(hookScriptPath, 0o755);

  const hooksPath = path.join(codexDir, 'hooks.json');
  mergeDmuxStopHook(hooksPath, `node ${shellQuote(hookScriptPath)}`);

  return { eventFile };
}

function buildCodexPaneAssignments(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): ShellAssignment[] {
  const assignments: ShellAssignment[] = [
    ['DMUX_PANE_ID', opts.dmuxPaneId],
    ['DMUX_TMUX_PANE_ID', opts.tmuxPaneId],
  ];

  if (opts.eventFile) {
    assignments.push(['DMUX_CODEX_HOOK_EVENT_FILE', opts.eventFile]);
  }

  return assignments;
}

export function buildCodexPaneEnvironmentPrefix(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): string {
  return buildCodexPaneAssignments(opts)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
}

export function buildCodexPaneExportSnippet(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): string {
  return buildCodexPaneAssignments(opts)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .map((assignment) => `export ${assignment}`)
    .join('; ');
}

export function enableCodexHooksFlag(command: string): string {
  return command.replace(/(^|;\s*)codex(?=\s|$)/, '$1codex --enable codex_hooks');
}

export function buildCodexHookedCommand(
  command: string,
  opts: {
    dmuxPaneId: string;
    tmuxPaneId: string;
    eventFile?: string;
  }
): string {
  return `${buildCodexPaneExportSnippet(opts)}; ${enableCodexHooksFlag(command)}`;
}
