import { describe, it, expect } from 'vitest';
import {
  getAgentDefinitions,
  getPromptTransport,
  getAgentShortLabel,
  appendSlugSuffix,
  buildAgentCommand,
  buildAgentLaunchInstances,
  buildAgentLaunchOptions,
  buildInitialPromptCommand,
  buildResumeCommand,
  buildAgentResumeOrLaunchCommand,
  getDefaultEnabledAgents,
  getAgentSlugSuffix,
  getPermissionFlags,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  buildGoalModePrompt,
  shouldEnableCodexGoals,
  supportsAgentGoalMode,
} from '../src/utils/agentLaunch.js';

describe('agent launch utils', () => {
  it('appends normalized slug suffix once', () => {
    expect(appendSlugSuffix('feature-a', 'Claude Code')).toBe('feature-a-claude-code');
    expect(appendSlugSuffix('feature-a-claude-code', 'claude-code')).toBe('feature-a-claude-code');
  });

  it('returns per-agent slug suffixes', () => {
    expect(getAgentSlugSuffix('claude')).toBe('claude-code');
    expect(getAgentSlugSuffix('opencode')).toBe('opencode');
    expect(getAgentSlugSuffix('codex')).toBe('codex');
    expect(getAgentSlugSuffix('grok')).toBe('grok-build');
    expect(getAgentSlugSuffix('gemini')).toBe('gemini');
    expect(getAgentSlugSuffix('deepcode')).toBe('deepcode');
  });

  it('returns default-enabled registry agents', () => {
    expect(getDefaultEnabledAgents()).toEqual(['claude', 'opencode', 'codex', 'grok']);
  });

  it('reports native goal-mode support for Claude and Codex only', () => {
    expect(supportsAgentGoalMode('claude')).toBe(true);
    expect(supportsAgentGoalMode('codex')).toBe(true);
    expect(supportsAgentGoalMode('grok')).toBe(false);
    expect(supportsAgentGoalMode('opencode')).toBe(false);
  });

  it('builds single-agent options from available agents', () => {
    const options = buildAgentLaunchOptions(['claude', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(options[1]?.agents).toEqual(['codex']);
  });

  it('builds one option per available agent', () => {
    const options = buildAgentLaunchOptions(['claude', 'opencode', 'codex']);
    expect(options.map((option) => option.id)).toEqual([
      'claude',
      'opencode',
      'codex',
    ]);
  });

  it('preserves duplicate agent launches and adds cardinal slug suffixes', () => {
    const launches = buildAgentLaunchInstances(['codex', 'codex', 'grok']);
    expect(launches).toEqual([
      {
        agent: 'codex',
        ordinal: 1,
        totalForAgent: 2,
        slugSuffix: 'codex-1',
      },
      {
        agent: 'codex',
        ordinal: 2,
        totalForAgent: 2,
        slugSuffix: 'codex-2',
      },
      {
        agent: 'grok',
        ordinal: 1,
        totalForAgent: 1,
        slugSuffix: 'grok-build',
      },
    ]);
  });

  it('omits launch suffixes for single-agent launches', () => {
    expect(buildAgentLaunchInstances(['grok'])).toEqual([
      {
        agent: 'grok',
        ordinal: 1,
        totalForAgent: 1,
        slugSuffix: undefined,
      },
    ]);
  });

  it('uses 2-character short labels for all agents', () => {
    const definitions = getAgentDefinitions();
    for (const definition of definitions) {
      expect(getAgentShortLabel(definition.id)).toHaveLength(2);
    }
  });

  it('uses unique short labels for all agents', () => {
    const definitions = getAgentDefinitions();
    const labels = definitions.map((definition) => getAgentShortLabel(definition.id));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('getPermissionFlags', () => {
  describe('claude', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('claude', '')).toBe('');
      expect(getPermissionFlags('claude', undefined)).toBe('');
    });

    it('returns plan mode flags', () => {
      expect(getPermissionFlags('claude', 'plan')).toBe('--permission-mode plan');
    });

    it('returns accept edits flags', () => {
      expect(getPermissionFlags('claude', 'acceptEdits')).toBe('--permission-mode acceptEdits');
    });

    it('returns bypass permissions flags', () => {
      expect(getPermissionFlags('claude', 'bypassPermissions')).toBe('--dangerously-skip-permissions');
    });
  });

  describe('codex', () => {
    it('returns no flags for empty/default mode', () => {
      expect(getPermissionFlags('codex', '')).toBe('');
      expect(getPermissionFlags('codex', undefined)).toBe('');
    });

    it('returns no flags for unsupported plan mode', () => {
      expect(getPermissionFlags('codex', 'plan')).toBe('');
    });

    it('returns accept edits flags', () => {
      expect(getPermissionFlags('codex', 'acceptEdits')).toBe('--full-auto');
    });

    it('returns bypass permissions flags', () => {
      expect(getPermissionFlags('codex', 'bypassPermissions')).toBe('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('opencode', () => {
    it('returns no flags for all modes', () => {
      expect(getPermissionFlags('opencode', '')).toBe('');
      expect(getPermissionFlags('opencode', undefined)).toBe('');
      expect(getPermissionFlags('opencode', 'plan')).toBe('');
      expect(getPermissionFlags('opencode', 'acceptEdits')).toBe('');
      expect(getPermissionFlags('opencode', 'bypassPermissions')).toBe('');
    });
  });

  describe('grok', () => {
    it('returns plan/accept/bypass permission flags', () => {
      expect(getPermissionFlags('grok', 'plan')).toBe('--permission-mode plan');
      expect(getPermissionFlags('grok', 'acceptEdits')).toBe('--permission-mode acceptEdits');
      expect(getPermissionFlags('grok', 'bypassPermissions')).toBe('--always-approve');
    });
  });

  describe('qwen', () => {
    it('returns plan/accept/bypass permission flags', () => {
      expect(getPermissionFlags('qwen', 'plan')).toBe('--approval-mode plan');
      expect(getPermissionFlags('qwen', 'acceptEdits')).toBe('--approval-mode auto-edit');
      expect(getPermissionFlags('qwen', 'bypassPermissions')).toBe('--approval-mode yolo');
    });
  });

  describe('gemini', () => {
    it('returns plan/accept/bypass permission flags', () => {
      expect(getPermissionFlags('gemini', 'plan')).toBe('--approval-mode plan');
      expect(getPermissionFlags('gemini', 'acceptEdits')).toBe('--approval-mode auto_edit');
      expect(getPermissionFlags('gemini', 'bypassPermissions')).toBe('--approval-mode yolo');
    });
  });

  describe('deepcode', () => {
    it('returns no flags for all modes', () => {
      expect(getPermissionFlags('deepcode', '')).toBe('');
      expect(getPermissionFlags('deepcode', undefined)).toBe('');
      expect(getPermissionFlags('deepcode', 'plan')).toBe('');
      expect(getPermissionFlags('deepcode', 'acceptEdits')).toBe('');
      expect(getPermissionFlags('deepcode', 'bypassPermissions')).toBe('');
    });
  });
});

describe('command builders', () => {
  it('builds command without an initial prompt', () => {
    expect(buildAgentCommand('claude', 'acceptEdits')).toBe(
      'claude --permission-mode acceptEdits'
    );
  });

  it('builds option-style initial prompt command', () => {
    expect(buildInitialPromptCommand('copilot', '"fix it"', 'acceptEdits')).toBe(
      'copilot --allow-tool write -i "fix it"'
    );
  });

  it('builds stdin-style initial prompt command', () => {
    expect(buildInitialPromptCommand('amp', '"fix it"', 'bypassPermissions')).toBe(
      "printf '%s\\n' \"fix it\" | amp --dangerously-allow-all"
    );
  });

  it('uses send-keys startup mode for crush initial prompts', () => {
    expect(getPromptTransport('crush')).toBe('send-keys');
    expect(buildInitialPromptCommand('crush', '"fix it"', 'bypassPermissions')).toBe(
      'crush --yolo'
    );
    expect(getSendKeysPrePrompt('crush')).toEqual(['Escape', 'Tab']);
    expect(getSendKeysSubmit('crush')).toEqual(['Enter']);
    expect(getSendKeysPostPasteDelayMs('crush')).toBe(200);
    expect(getSendKeysReadyDelayMs('crush')).toBe(1200);
  });

  it('uses send-keys startup mode for deepcode initial prompts', () => {
    expect(getPromptTransport('deepcode')).toBe('send-keys');
    expect(buildInitialPromptCommand('deepcode', '"fix it"', '')).toBe(
      'deepcode'
    );
    expect(getSendKeysSubmit('deepcode')).toEqual(['Enter']);
    expect(getSendKeysPostPasteDelayMs('deepcode')).toBe(200);
    expect(getSendKeysReadyDelayMs('deepcode')).toBe(2000);
  });

  it('uses send-keys startup mode for cline initial prompts', () => {
    expect(getPromptTransport('cline')).toBe('send-keys');
    expect(buildInitialPromptCommand('cline', '"fix it"', 'acceptEdits')).toBe(
      'cline --act'
    );
    expect(getSendKeysPostPasteDelayMs('cline')).toBe(120);
    expect(getSendKeysReadyDelayMs('cline')).toBe(2500);
  });

  it('uses interactive prompt option for gemini', () => {
    expect(buildInitialPromptCommand('gemini', '"fix it"', 'bypassPermissions')).toBe(
      'gemini --approval-mode yolo --prompt-interactive "fix it"'
    );
  });

  it('uses send-keys startup mode for grok initial prompts', () => {
    expect(getPromptTransport('grok')).toBe('send-keys');
    expect(buildInitialPromptCommand('grok', '"fix it"', 'bypassPermissions')).toBe(
      'grok --always-approve'
    );
    expect(getSendKeysSubmit('grok')).toEqual(['Enter']);
    expect(getSendKeysPostPasteDelayMs('grok')).toBe(150);
    expect(getSendKeysReadyDelayMs('grok')).toBe(1600);
  });

  it('builds grok resume command scoped to the current directory', () => {
    expect(buildResumeCommand('grok', 'bypassPermissions')).toBe(
      'grok --continue --always-approve'
    );
  });

  it('builds gemini resume command', () => {
    expect(buildResumeCommand('gemini', 'bypassPermissions')).toBe(
      'gemini --resume latest --approval-mode yolo'
    );
  });

  it('builds codex resume command with per-agent permissions', () => {
    expect(buildResumeCommand('codex', 'bypassPermissions')).toBe(
      'codex resume --last --dangerously-bypass-approvals-and-sandbox'
    );
  });

  it('wraps supported initial prompts in /goal when goal mode is enabled', () => {
    expect(buildGoalModePrompt('claude', 'fix the failing test', true)).toBe(
      '/goal fix the failing test'
    );
    expect(buildGoalModePrompt('codex', 'ship it', true)).toBe('/goal ship it');
    expect(buildGoalModePrompt('opencode', 'ship it', true)).toBe('ship it');
    expect(shouldEnableCodexGoals('codex', true)).toBe(true);
    expect(shouldEnableCodexGoals('claude', true)).toBe(false);
  });

  it('falls back to launch command when an agent has no resume template', () => {
    expect(buildAgentResumeOrLaunchCommand('opencode', 'bypassPermissions')).toBe(
      'opencode'
    );
  });
});
