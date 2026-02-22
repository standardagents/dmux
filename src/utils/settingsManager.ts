import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { DmuxSettings, SettingsScope, SettingDefinition } from '../types.js';
import { isValidBranchName } from './git.js';

const GLOBAL_SETTINGS_PATH = join(homedir(), '.dmux.global.json');
const PERMISSION_MODES = ['', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
function isPermissionMode(value: string): value is NonNullable<DmuxSettings['permissionMode']> {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}
const DEFAULT_SETTINGS: DmuxSettings = {
  // Most permissive defaults for new dmux setups.
  permissionMode: 'bypassPermissions',
  enableAutopilotByDefault: true,
};

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'permissionMode',
    label: 'Agent Permission Mode',
    description: 'Controls how much permission is granted to launched agents',
    type: 'select',
    options: [
      { value: '', label: 'Agent default (ask)' },
      { value: 'plan', label: 'Plan mode (Claude only)' },
      { value: 'acceptEdits', label: 'Accept edits' },
      { value: 'bypassPermissions', label: 'Bypass permissions (most permissive)' },
    ],
  },
  {
    key: 'enableAutopilotByDefault',
    label: 'Enable Autopilot by Default',
    description: 'Automatically accept options when no risk is detected for new panes',
    type: 'boolean',
  },
  {
    key: 'defaultAgent',
    label: 'Default Agent',
    description: 'Skip agent selection and use this agent for all new panes',
    type: 'select',
    options: [
      { value: '', label: 'Ask each time' },
      { value: 'claude', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
      { value: 'codex', label: 'Codex' },
    ],
  },
  {
    key: 'slugProvider',
    label: 'Slug Generation Provider',
    description: 'How to generate branch name slugs. OpenRouter requires OPENROUTER_API_KEY env var.',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto (local agent)' },
      { value: 'openrouter', label: 'OpenRouter API' },
      { value: 'claude', label: 'Claude CLI' },
      { value: 'codex', label: 'Codex CLI' },
    ],
  },
  {
    key: 'openrouterApiKey',
    label: 'OpenRouter API Key',
    description: 'API key for OpenRouter slug generation. Persisted to your shell config.',
    type: 'text',
  },
  {
    key: 'useTmuxHooks',
    label: 'Use Tmux Hooks',
    description: 'Use tmux hooks for event-driven updates (lower CPU). If disabled, uses polling in a worker thread.',
    type: 'boolean',
  },
  {
    key: 'baseBranch',
    label: 'Base Branch',
    description: 'Branch to create new worktrees from. Leave empty to use current HEAD.',
    type: 'text',
  },
  {
    key: 'branchPrefix',
    label: 'Branch Name Prefix',
    description: 'Prefix for new branch names (e.g. "feat/" produces branch "feat/fix-auth"). Leave empty for no prefix.',
    type: 'select',
    options: [
      { value: '', label: 'No prefix (default)' },
      { value: 'feat/', label: 'feat/' },
      { value: 'fix/', label: 'fix/' },
      { value: 'chore/', label: 'chore/' },
    ],
  },
  {
    key: 'hooks' as any,
    label: 'Manage Hooks',
    description: 'View and edit dmux lifecycle hooks',
    type: 'action' as any,
  },
];

export class SettingsManager {
  private globalPath: string;
  private projectPath: string;
  private globalSettings: DmuxSettings = {};
  private projectSettings: DmuxSettings = {};

  constructor(projectRoot?: string) {
    this.globalPath = GLOBAL_SETTINGS_PATH;
    this.projectPath = join(projectRoot || process.cwd(), '.dmux', 'settings.json');
    this.loadSettings();
  }

  private loadSettings(): void {
    // Load global settings
    if (existsSync(this.globalPath)) {
      try {
        const data = readFileSync(this.globalPath, 'utf-8');
        this.globalSettings = JSON.parse(data);
      } catch (error) {
        console.error('Failed to load global settings:', error);
      }
    }

    // Load project settings
    if (existsSync(this.projectPath)) {
      try {
        const data = readFileSync(this.projectPath, 'utf-8');
        this.projectSettings = JSON.parse(data);
      } catch (error) {
        console.error('Failed to load project settings:', error);
      }
    }
  }

  /**
   * Get merged settings (project settings override global)
   */
  getSettings(): DmuxSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...this.globalSettings,
      ...this.projectSettings,
    };
  }

  /**
   * Get a specific setting value (with project override)
   */
  getSetting<K extends keyof DmuxSettings>(key: K): DmuxSettings[K] {
    const merged = this.getSettings();
    return merged[key];
  }

  /**
   * Get global settings only
   */
  getGlobalSettings(): DmuxSettings {
    return { ...this.globalSettings };
  }

  /**
   * Get project settings only
   */
  getProjectSettings(): DmuxSettings {
    return { ...this.projectSettings };
  }

  /**
   * Update a setting at the specified scope
   */
  updateSetting<K extends keyof DmuxSettings>(
    key: K,
    value: DmuxSettings[K],
    scope: SettingsScope
  ): void {
    // Validate branch-related settings
    if ((key === 'baseBranch' || key === 'branchPrefix') && typeof value === 'string' && value !== '') {
      if (!isValidBranchName(value)) {
        throw new Error(`Invalid ${key}: contains characters not allowed in git branch names`);
      }
    }
    if (key === 'permissionMode' && typeof value === 'string' && !isPermissionMode(value)) {
      throw new Error(`Invalid permissionMode: "${value}"`);
    }

    if (scope === 'global') {
      this.globalSettings[key] = value;
      this.saveGlobalSettings();
    } else {
      this.projectSettings[key] = value;
      this.saveProjectSettings();
    }
  }

  /**
   * Update multiple settings at once
   */
  updateSettings(settings: Partial<DmuxSettings>, scope: SettingsScope): void {
    if (typeof settings.permissionMode === 'string' && !isPermissionMode(settings.permissionMode)) {
      throw new Error(`Invalid permissionMode: "${settings.permissionMode}"`);
    }
    if (typeof settings.baseBranch === 'string' && settings.baseBranch !== '' && !isValidBranchName(settings.baseBranch)) {
      throw new Error('Invalid baseBranch: contains characters not allowed in git branch names');
    }
    if (typeof settings.branchPrefix === 'string' && settings.branchPrefix !== '' && !isValidBranchName(settings.branchPrefix)) {
      throw new Error('Invalid branchPrefix: contains characters not allowed in git branch names');
    }

    if (scope === 'global') {
      this.globalSettings = { ...this.globalSettings, ...settings };
      this.saveGlobalSettings();
    } else {
      this.projectSettings = { ...this.projectSettings, ...settings };
      this.saveProjectSettings();
    }
  }

  /**
   * Remove a setting from the specified scope
   */
  removeSetting(key: keyof DmuxSettings, scope: SettingsScope): void {
    if (scope === 'global') {
      delete this.globalSettings[key];
      this.saveGlobalSettings();
    } else {
      delete this.projectSettings[key];
      this.saveProjectSettings();
    }
  }

  private saveGlobalSettings(): void {
    try {
      const dir = dirname(this.globalPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.globalPath, JSON.stringify(this.globalSettings, null, 2));
    } catch (error) {
      console.error('Failed to save global settings:', error);
      throw error;
    }
  }

  private saveProjectSettings(): void {
    try {
      const dir = dirname(this.projectPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.projectPath, JSON.stringify(this.projectSettings, null, 2));
    } catch (error) {
      console.error('Failed to save project settings:', error);
      throw error;
    }
  }

  /**
   * Check if a setting is overridden at the project level
   */
  isProjectOverride(key: keyof DmuxSettings): boolean {
    return key in this.projectSettings;
  }

  /**
   * Get the effective scope for a setting (where it's currently defined)
   */
  getEffectiveScope(key: keyof DmuxSettings): SettingsScope | null {
    if (key in this.projectSettings) return 'project';
    if (key in this.globalSettings) return 'global';
    return null;
  }
}
