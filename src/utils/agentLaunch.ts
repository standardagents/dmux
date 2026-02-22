import { TmuxService } from '../services/TmuxService.js';
import {
  buildPromptReadAndDeleteSnippet,
  writePromptFile,
} from './promptStore.js';

export type AgentName = 'claude' | 'opencode' | 'codex';

export interface AgentLaunchOption {
  id: string;
  label: string;
  agents: AgentName[];
  isPair: boolean;
}

const AGENT_LABELS: Record<AgentName, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

const AGENT_SLUG_SUFFIXES: Record<AgentName, string> = {
  claude: 'claude-code',
  opencode: 'opencode',
  codex: 'codex',
};

export function getAgentLabel(agent: AgentName): string {
  return AGENT_LABELS[agent];
}

export function getAgentSlugSuffix(agent: AgentName): string {
  return AGENT_SLUG_SUFFIXES[agent];
}

export function appendSlugSuffix(baseSlug: string, slugSuffix?: string): string {
  if (!slugSuffix) return baseSlug;

  const normalizedSuffix = slugSuffix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalizedSuffix) return baseSlug;
  if (baseSlug === normalizedSuffix || baseSlug.endsWith(`-${normalizedSuffix}`)) {
    return baseSlug;
  }

  return `${baseSlug}-${normalizedSuffix}`;
}

export function buildAgentLaunchOptions(
  availableAgents: AgentName[]
): AgentLaunchOption[] {
  const uniqueAgents = availableAgents.filter(
    (agent, index) => availableAgents.indexOf(agent) === index
  );

  const singleAgentOptions: AgentLaunchOption[] = uniqueAgents.map((agent) => ({
    id: agent,
    label: getAgentLabel(agent),
    agents: [agent],
    isPair: false,
  }));

  const pairOptions: AgentLaunchOption[] = [];
  for (let i = 0; i < uniqueAgents.length; i++) {
    for (let j = i + 1; j < uniqueAgents.length; j++) {
      const first = uniqueAgents[i];
      const second = uniqueAgents[j];
      pairOptions.push({
        id: `${first}+${second}`,
        label: `A/B: ${getAgentLabel(first)} + ${getAgentLabel(second)}`,
        agents: [first, second],
        isPair: true,
      });
    }
  }

  return [...singleAgentOptions, ...pairOptions];
}

/**
 * Resolve CLI permission flags for a given agent and dmux permissionMode.
 */
export function getPermissionFlags(
  agent: AgentName,
  permissionMode: '' | 'plan' | 'acceptEdits' | 'bypassPermissions' | undefined
): string {
  const mode = permissionMode || '';

  if (agent === 'claude') {
    if (mode === 'plan') return '--permission-mode plan';
    if (mode === 'acceptEdits') return '--permission-mode acceptEdits';
    if (mode === 'bypassPermissions') return '--dangerously-skip-permissions';
    return '';
  }

  if (agent === 'codex') {
    if (mode === 'acceptEdits') return '--approval-mode auto-edit';
    if (mode === 'bypassPermissions') return '--dangerously-bypass-approvals-and-sandbox';
    return '';
  }

  // opencode currently has no equivalent permission flags for these modes.
  return '';
}

/**
 * Launch an agent CLI inside an already-existing tmux pane.
 *
 * Shared by `createPane()` (new worktree panes) and `attachAgentToWorktree()`
 * (sibling panes reusing an existing worktree).
 */
export async function launchAgentInPane(opts: {
  paneId: string;
  agent: AgentName;
  prompt: string;
  slug: string;
  projectRoot: string;
  permissionMode?: '' | 'plan' | 'acceptEdits' | 'bypassPermissions';
}): Promise<void> {
  const { paneId, agent, prompt, slug, projectRoot, permissionMode } = opts;
  const tmuxService = TmuxService.getInstance();
  const hasInitialPrompt = !!(prompt && prompt.trim());

  if (agent === 'claude') {
    const permissionFlags = getPermissionFlags('claude', permissionMode);
    const permissionSuffix = permissionFlags ? ` ${permissionFlags}` : '';
    let claudeCmd: string;
    if (hasInitialPrompt) {
      let promptFilePath: string | null = null;
      try {
        promptFilePath = await writePromptFile(projectRoot, slug, prompt);
      } catch {
        // Fall back to inline escaping if prompt file write fails
      }

      if (promptFilePath) {
        const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
        claudeCmd = `${promptBootstrap}; claude "$DMUX_PROMPT_CONTENT"${permissionSuffix}`;
      } else {
        const escapedPrompt = prompt
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/`/g, '\\`')
          .replace(/\$/g, '\\$');
        claudeCmd = `claude "${escapedPrompt}"${permissionSuffix}`;
      }
    } else {
      claudeCmd = `claude${permissionSuffix}`;
    }
    await tmuxService.sendShellCommand(paneId, claudeCmd);
    await tmuxService.sendTmuxKeys(paneId, 'Enter');
  } else if (agent === 'codex') {
    const permissionFlags = getPermissionFlags('codex', permissionMode);
    const permissionSuffix = permissionFlags ? ` ${permissionFlags}` : '';
    let codexCmd: string;
    if (hasInitialPrompt) {
      let promptFilePath: string | null = null;
      try {
        promptFilePath = await writePromptFile(projectRoot, slug, prompt);
      } catch {
        // Fall back to inline escaping if prompt file write fails
      }

      if (promptFilePath) {
        const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
        codexCmd = `${promptBootstrap}; codex "$DMUX_PROMPT_CONTENT"${permissionSuffix}`;
      } else {
        const escapedPrompt = prompt
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/`/g, '\\`')
          .replace(/\$/g, '\\$');
        codexCmd = `codex "${escapedPrompt}"${permissionSuffix}`;
      }
    } else {
      codexCmd = `codex${permissionSuffix}`;
    }
    await tmuxService.sendShellCommand(paneId, codexCmd);
    await tmuxService.sendTmuxKeys(paneId, 'Enter');
  } else if (agent === 'opencode') {
    let opencodeCmd: string;
    if (hasInitialPrompt) {
      let promptFilePath: string | null = null;
      try {
        promptFilePath = await writePromptFile(projectRoot, slug, prompt);
      } catch {
        // Fall back to inline escaping if prompt file write fails
      }

      if (promptFilePath) {
        const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
        opencodeCmd = `${promptBootstrap}; opencode --prompt "$DMUX_PROMPT_CONTENT"`;
      } else {
        const escapedPrompt = prompt
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/`/g, '\\`')
          .replace(/\$/g, '\\$');
        opencodeCmd = `opencode --prompt "${escapedPrompt}"`;
      }
    } else {
      opencodeCmd = 'opencode';
    }
    await tmuxService.sendShellCommand(paneId, opencodeCmd);
    await tmuxService.sendTmuxKeys(paneId, 'Enter');
  }
}
