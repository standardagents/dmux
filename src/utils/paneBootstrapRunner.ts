#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import React, { useEffect, useState } from 'react';
import {
  Box,
  Text,
  render as renderInk,
  useApp,
} from 'ink';
import type { PaneBootstrapConfig } from './paneBootstrapConfig.js';
import {
  buildAgentCommand,
  buildInitialPromptCommand,
  buildGoalModePrompt,
  getAgentLabel,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  getPromptTransport,
  shouldEnableCodexGoals,
} from './agentLaunch.js';
import {
  buildPromptReadAndDeleteSnippet,
  writePromptFile,
} from './promptStore.js';
import { triggerHookWithProgress, initializeHooksDirectory } from './hooks.js';
import { writeWorktreeMetadata } from './worktreeMetadata.js';
import { ensureWorkspaceWorktrees, type WorkspaceWorktreeTarget } from './linkedWorktrees.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import {
  buildCodexHookedCommand,
  installCodexPaneHooks,
} from './codexHooks.js';
import { installClaudePaneHooks } from './claudeHooks.js';
import { TmuxService } from '../services/TmuxService.js';
import { getPaneTmuxTitle } from './paneTitle.js';

type StepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

interface Step {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

interface ViewState {
  steps: Step[];
  currentDetail: string;
  recentMessages?: string[];
  failedMessage?: string;
  completeMessage?: string;
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BOOTSTRAP_HOOK_TIMEOUT_MS = 0;
let inkInstance: ReturnType<typeof renderInk> | null = null;
let viewState: ViewState = {
  steps: [],
  currentDetail: '',
};
const viewListeners = new Set<(state: ViewState) => void>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneSteps(steps: Step[]): Step[] {
  return steps.map((step) => ({ ...step }));
}

function updateViewState(patch: Partial<ViewState>): void {
  viewState = {
    ...viewState,
    ...patch,
    steps: patch.steps ? cloneSteps(patch.steps) : viewState.steps,
  };
  for (const listener of viewListeners) {
    listener(viewState);
  }
}

function normalizeProgressLine(line: string): string {
  return line
    .replace(/^\s*(DMUX_STATUS:|dmux:|status:)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function appendProgressLine(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  const normalized = normalizeProgressLine(line);
  if (!normalized) return;

  const prefix = stream === 'stderr' ? '! ' : '';
  const nextLine = `${prefix}${normalized}`;
  updateViewState({
    currentDetail: normalized,
    recentMessages: [...(viewState.recentMessages || []), nextLine].slice(-5),
  });
}

function appendProgressChunk(
  chunk: string,
  stream: 'stdout' | 'stderr',
  remainder: string
): string {
  const content = remainder + chunk;
  const lines = content.split(/\r?\n/);
  const nextRemainder = lines.pop() || '';

  for (const line of lines) {
    appendProgressLine(line, stream);
  }

  return nextRemainder;
}

function useBootstrapSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [active]);

  return spinnerFrames[frame];
}

function StepMarker(props: { step: Step; spinner: string }): React.ReactElement {
  const { step, spinner } = props;
  if (step.state === 'done') {
    return React.createElement(Text, { color: 'green' }, '✔');
  }
  if (step.state === 'failed') {
    return React.createElement(Text, { color: 'red' }, '✖');
  }
  if (step.state === 'skipped') {
    return React.createElement(Text, { dimColor: true }, '◌');
  }
  if (step.state === 'active') {
    return React.createElement(Text, { color: 'cyan' }, spinner);
  }
  return React.createElement(Text, { dimColor: true }, '○');
}

function BootstrapApp(props: { config: PaneBootstrapConfig }): React.ReactElement {
  const { config } = props;
  const [state, setState] = useState<ViewState>(viewState);
  const hasActiveStep = state.steps.some((step) => step.state === 'active');
  const spinner = useBootstrapSpinner(hasActiveStep);
  const agentLabel = config.agent ? getAgentLabel(config.agent) : 'shell';
  const { exit } = useApp();

  useEffect(() => {
    const listener = (nextState: ViewState) => setState(nextState);
    viewListeners.add(listener);
    return () => {
      viewListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (state.completeMessage) {
      const timer = setTimeout(exit, 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [exit, state.completeMessage]);

  const borderColor = state.failedMessage ? 'red' : state.completeMessage ? 'green' : 'cyan';
  const activeStep = state.steps.find((step) => step.state === 'active');
  const totalSteps = state.steps.length;
  const completedSteps = state.steps.filter(
    (step) => step.state === 'done' || step.state === 'skipped'
  ).length;
  const progressWidth = 12;
  const filledBars = totalSteps === 0
    ? 0
    : Math.round((completedSteps / totalSteps) * progressWidth);
  const progressBar =
    '▰'.repeat(filledBars) + '▱'.repeat(progressWidth - filledBars);
  const headline = state.failedMessage
    ? 'setup needs attention'
    : state.completeMessage
      ? 'ready to launch'
      : 'preparing your agent';

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, paddingY: 1 },
    React.createElement(
      Box,
      {
        borderStyle: 'round',
        borderColor,
        flexDirection: 'column',
        paddingX: 2,
        paddingY: 1,
      },
      React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Text, { bold: true, color: borderColor }, 'dmux'),
          React.createElement(Text, { dimColor: true }, '  ·  '),
          React.createElement(Text, null, headline)
        ),
        React.createElement(
          Text,
          { dimColor: true },
          'Worktree and hooks go first, then your agent takes over.'
        )
      ),
      React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 1 },
        React.createElement(
          Text,
          null,
          React.createElement(Text, { dimColor: true }, 'pane    '),
          React.createElement(Text, { bold: true }, config.slug)
        ),
        React.createElement(
          Text,
          null,
          React.createElement(Text, { dimColor: true }, 'branch  '),
          React.createElement(Text, { bold: true }, config.branchName)
        ),
        React.createElement(
          Text,
          null,
          React.createElement(Text, { dimColor: true }, 'agent   '),
          React.createElement(Text, { bold: true }, agentLabel)
        )
      ),
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...state.steps.map((step) =>
          React.createElement(
            Box,
            { key: step.id },
            React.createElement(StepMarker, { step, spinner }),
            React.createElement(Text, null, '  '),
            React.createElement(
              Text,
              {
                color:
                  step.state === 'active'
                    ? 'cyan'
                    : step.state === 'failed'
                      ? 'red'
                      : undefined,
                dimColor:
                  step.state === 'pending' || step.state === 'skipped'
                    ? true
                    : undefined,
              },
              step.label
            ),
            step.detail
              ? React.createElement(Text, { dimColor: true }, `  ${step.detail}`)
              : null
          )
        )
      ),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { color: borderColor }, progressBar),
        React.createElement(
          Text,
          { dimColor: true },
          `  ${completedSteps} / ${totalSteps}`
        )
      ),
      React.createElement(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        state.failedMessage
          ? React.createElement(Text, { color: 'red' }, `✖  ${state.failedMessage}`)
          : React.createElement(
              Text,
              { dimColor: true },
              state.currentDetail
                ? `→  ${state.currentDetail}`
                : activeStep
                  ? `→  ${activeStep.label}`
                  : state.completeMessage
                    ? '✓  ready to launch'
                    : 'waiting for the next setup step…'
            )
      ),
      state.recentMessages && state.recentMessages.length > 0
        ? React.createElement(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            React.createElement(Text, { dimColor: true }, 'recent output'),
            ...state.recentMessages.map((message, index) =>
              React.createElement(
                Text,
                {
                  key: `${index}-${message}`,
                  color: message.startsWith('! ') ? 'yellow' : undefined,
                  dimColor: !message.startsWith('! '),
                },
                `  ${message}`
              )
            )
          )
        : null
      )
  );
}

function startRendering(config: PaneBootstrapConfig, steps: Step[]): void {
  viewState = {
    steps: cloneSteps(steps),
    currentDetail: 'Starting setup...',
  };
  inkInstance = renderInk(React.createElement(BootstrapApp, { config }));
}

function stopRendering(message?: string): void {
  updateViewState({
    completeMessage: message || 'Setup complete',
    currentDetail: message || '',
  });
  inkInstance?.unmount();
  inkInstance = null;
}

function setStep(
  config: PaneBootstrapConfig,
  steps: Step[],
  id: string,
  state: StepState,
  detail?: string
): void {
  const step = steps.find((candidate) => candidate.id === id);
  if (!step) return;
  step.state = state;
  step.detail = detail;
  updateViewState({ steps });
}

function buildSteps(config: PaneBootstrapConfig): Step[] {
  return [
    {
      id: 'worktree',
      label: config.existingWorktree ? 'Opening existing worktree' : 'Creating git worktree',
      state: 'pending',
    },
    {
      id: 'metadata',
      label: 'Writing dmux metadata',
      state: 'pending',
    },
    {
      id: 'hooks-docs',
      label: 'Preparing hook docs',
      state: config.isHooksEditingSession ? 'pending' : 'skipped',
    },
    {
      id: 'worktree-hook',
      label: 'Running worktree_created hook',
      state: 'pending',
    },
    {
      id: 'agent',
      label: config.agent ? `Launching ${getAgentLabel(config.agent)}` : 'Opening shell',
      state: 'pending',
    },
  ];
}

function commandToString(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

async function runCommand(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    updateViewState({ currentDetail: commandToString(command, args) });
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutRemainder = '';
    let stderrRemainder = '';

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      stdoutRemainder = appendProgressChunk(chunk, 'stdout', stdoutRemainder);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      stderrRemainder = appendProgressChunk(chunk, 'stderr', stderrRemainder);
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      appendProgressLine(stdoutRemainder, 'stdout');
      appendProgressLine(stderrRemainder, 'stderr');
      updateViewState({ currentDetail: '' });
      if (code === 0 || opts.allowFailure) {
        resolve({ stdout, stderr, code });
        return;
      }
      const message = (stderr || stdout || `Command failed with exit code ${code}`).trim();
      reject(new Error(message));
    });
  });
}

async function enforcePaneTitle(config: PaneBootstrapConfig): Promise<void> {
  const tmuxTitle = config.tmuxTitle
    || getPaneTmuxTitle(config.pane, config.projectRoot, config.pane.projectName);
  try {
    await TmuxService.getInstance().setPaneTitle(config.pane.paneId, tmuxTitle);
  } catch {
    // The pane may already be gone; title repair is best-effort.
  }
}

async function commandSucceeds(command: string, args: string[], cwd: string): Promise<boolean> {
  const result = await runCommand(command, args, {
    cwd,
    allowFailure: true,
  });
  return result.code === 0;
}

async function prepareWorktree(config: PaneBootstrapConfig): Promise<WorkspaceWorktreeTarget[]> {
  if (config.existingWorktree && !fs.existsSync(path.join(config.worktreePath, '.git'))) {
    throw new Error(`Existing worktree not found at ${config.worktreePath}`);
  }

  if (config.resolvedStartPoint) {
    const startPointExists = await commandSucceeds(
      'git',
      ['rev-parse', '--verify', '--end-of-options', config.resolvedStartPoint],
      config.projectRoot
    );
    if (!startPointExists) {
      throw new Error(`Worktree start point "${config.resolvedStartPoint}" does not exist`);
    }
  }

  return ensureWorkspaceWorktrees({
    projectRoot: config.projectRoot,
    rootWorktreePath: config.worktreePath,
    branchName: config.branchName,
    linkedRepoPaths: config.metadata.linkedRepoPaths,
    preferredStartPoint: config.resolvedStartPoint,
    fallbackStartPointMode: 'current-head',
  });
}

async function sendInteractivePrompt(config: PaneBootstrapConfig): Promise<void> {
  if (!config.agent || !config.prompt.trim()) {
    return;
  }

  const tmuxService = TmuxService.getInstance();
  const readyDelayMs = getSendKeysReadyDelayMs(config.agent);
  if (readyDelayMs > 0) {
    await sleep(readyDelayMs);
  }

  const bufferName = `dmux-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    for (const key of getSendKeysPrePrompt(config.agent)) {
      await tmuxService.sendTmuxKeys(config.pane.paneId, key);
      await sleep(120);
    }

    await tmuxService.setBuffer(
      bufferName,
      buildGoalModePrompt(config.agent, config.prompt, config.goalMode)
    );
    await tmuxService.pasteBuffer(bufferName, config.pane.paneId);

    const postPasteDelayMs = getSendKeysPostPasteDelayMs(config.agent);
    if (postPasteDelayMs > 0) {
      await sleep(postPasteDelayMs);
    }

    for (const key of getSendKeysSubmit(config.agent)) {
      await tmuxService.sendTmuxKeys(config.pane.paneId, key);
      await sleep(60);
    }
  } finally {
    try {
      await tmuxService.deleteBuffer(bufferName);
    } catch {
      // Best-effort cleanup.
    }
  }
}

function writeLinkedWorktreeMetadata(
  config: PaneBootstrapConfig,
  targets: WorkspaceWorktreeTarget[]
): void {
  for (const target of targets) {
    if (target.isRoot) {
      continue;
    }

    writeWorktreeMetadata(target.worktreePath, {
      branchName: config.branchName !== config.slug ? config.branchName : undefined,
    });
  }
}

async function runChildWorktreeHooks(
  config: PaneBootstrapConfig,
  targets: WorkspaceWorktreeTarget[]
): Promise<void> {
  for (const target of targets) {
    if (target.isRoot) {
      continue;
    }

    const hookResult = await triggerHookWithProgress(
      'worktree_created',
      target.repoPath,
      undefined,
      {
        ...config.hookExtraEnv,
        DMUX_PROGRESS: '1',
        DMUX_STATUS_PREFIX: 'DMUX_STATUS:',
        DMUX_SLUG: config.slug,
        DMUX_PROMPT: config.prompt || 'No initial prompt',
        DMUX_AGENT: config.agent || 'unknown',
        DMUX_WORKTREE_PATH: target.worktreePath,
        DMUX_BRANCH: config.branchName,
      },
      (event) => appendProgressLine(event.line, event.stream),
      BOOTSTRAP_HOOK_TIMEOUT_MS
    );

    if (!hookResult.success) {
      throw new Error(hookResult.error || 'linked worktree_created hook failed');
    }
  }
}

async function buildLaunchCommand(config: PaneBootstrapConfig): Promise<string | null> {
  if (!config.agent) {
    return null;
  }

  const hasInitialPrompt = !!config.prompt.trim();
  const promptTransport = getPromptTransport(config.agent);
  const launchPrompt = buildGoalModePrompt(config.agent, config.prompt, config.goalMode);
  let launchCommand: string;

  if (hasInitialPrompt && promptTransport !== 'send-keys') {
    let promptFilePath: string | null = null;
    try {
      promptFilePath = await writePromptFile(config.projectRoot, config.slug, launchPrompt);
    } catch {
      promptFilePath = null;
    }

    if (promptFilePath) {
      const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
      launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
        config.agent,
        '"$DMUX_PROMPT_CONTENT"',
        config.permissionMode
      )}`;
    } else {
      const escapedPrompt = launchPrompt
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      launchCommand = buildInitialPromptCommand(
        config.agent,
        `"${escapedPrompt}"`,
        config.permissionMode
      );
    }
  } else {
    launchCommand = buildAgentCommand(config.agent, config.permissionMode);
  }

  if (config.agent === 'claude') {
    try {
      installClaudePaneHooks({
        worktreePath: config.worktreePath,
        dmuxPaneId: config.pane.id,
        tmuxPaneId: config.pane.paneId,
      });
    } catch {
      // Hook installation is best effort; Claude can still run normally.
    }
  }

  if (config.agent === 'codex') {
    let codexHookEventFile: string | undefined;
    try {
      codexHookEventFile = installCodexPaneHooks({
        worktreePath: config.worktreePath,
        dmuxPaneId: config.pane.id,
        tmuxPaneId: config.pane.paneId,
      }).eventFile;
    } catch {
      codexHookEventFile = undefined;
    }

    launchCommand = buildCodexHookedCommand(launchCommand, {
      dmuxPaneId: config.pane.id,
      tmuxPaneId: config.pane.paneId,
      eventFile: codexHookEventFile,
    }, {
      enableGoals: shouldEnableCodexGoals(config.agent, config.goalMode),
    });
  }

  return launchCommand;
}

async function runAgent(config: PaneBootstrapConfig, launchCommand: string | null): Promise<number> {
  if (!launchCommand) {
    updateViewState({ currentDetail: `Worktree ready at ${config.worktreePath}` });
    return 0;
  }

  await enforcePaneTitle(config);
  updateViewState({ currentDetail: launchCommand });
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`dmux setup complete. Launching ${getAgentLabel(config.agent!)}...\n\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(launchCommand, {
      cwd: config.worktreePath,
      env: {
        ...process.env,
        DMUX_PANE_ID: config.pane.id,
        DMUX_TMUX_PANE_ID: config.pane.paneId,
      },
      shell: true,
      stdio: 'inherit',
    });

    const forwardSignal = (signal?: NodeJS.Signals) => {
      try {
        child.kill(signal || 'SIGTERM');
      } catch {
        // Ignore signal forwarding failures.
      }
    };

    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);

    if (config.agent && getPromptTransport(config.agent) === 'send-keys') {
      sendInteractivePrompt(config).catch(() => {
        // The agent may still accept manual input if automated paste fails.
      });
    }

    child.on('error', (error) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      reject(error);
    });
    child.on('close', (code) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<number> {
  const configPath = process.argv[2];
  if (!configPath) {
    process.stderr.write('Usage: paneBootstrapRunner <config.json>\n');
    return 1;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as PaneBootstrapConfig;
  const steps = buildSteps(config);
  await enforcePaneTitle(config);
  startRendering(config, steps);

  try {
    setStep(config, steps, 'worktree', 'active');
    const workspaceTargets = await prepareWorktree(config);
    setStep(config, steps, 'worktree', 'done', workspaceTargets.length > 1
      ? `${config.worktreePath} (+${workspaceTargets.length - 1} linked)`
      : config.worktreePath);

    setStep(config, steps, 'metadata', 'active');
    writeWorktreeMetadata(config.worktreePath, config.metadata);
    writeLinkedWorktreeMetadata(config, workspaceTargets);
    setStep(config, steps, 'metadata', 'done');

    if (config.isHooksEditingSession) {
      setStep(config, steps, 'hooks-docs', 'active');
      initializeHooksDirectory(config.worktreePath);
      setStep(config, steps, 'hooks-docs', 'done');
    }

    setStep(config, steps, 'worktree-hook', 'active');
    const hookResult = await triggerHookWithProgress(
      'worktree_created',
      config.projectRoot,
      config.pane,
      {
        ...config.hookExtraEnv,
        DMUX_PROGRESS: '1',
        DMUX_STATUS_PREFIX: 'DMUX_STATUS:',
      },
      (event) => appendProgressLine(event.line, event.stream),
      BOOTSTRAP_HOOK_TIMEOUT_MS
    );
    if (!hookResult.success) {
      throw new Error(hookResult.error || 'worktree_created hook failed');
    }

    if (!config.existingWorktree) {
      await runChildWorktreeHooks(config, workspaceTargets);
    }

    setStep(config, steps, 'worktree-hook', 'done');

    if (config.agent === 'gemini') {
      ensureGeminiFolderTrusted(config.worktreePath);
    }

    setStep(config, steps, 'agent', 'active');
    const launchCommand = await buildLaunchCommand(config);
    setStep(config, steps, 'agent', 'done');
    stopRendering('Setup complete. Starting agent...');

    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // Keep going; stale bootstrap configs are harmless.
    }

    return await runAgent(config, launchCommand);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const activeStep = steps.find((step) => step.state === 'active');
    if (activeStep) {
      setStep(config, steps, activeStep.id, 'failed', message);
    }
    updateViewState({
      currentDetail: message,
      failedMessage: message,
    });
    await enforcePaneTitle(config);
    inkInstance?.unmount();
    inkInstance = null;
    process.stdout.write('\n');
    process.stdout.write('dmux setup failed. The agent was not launched.\n');
    process.stdout.write(`${message}\n`);
    process.stdout.write('Fix the issue above, then close this pane or retry from dmux.\n');
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
