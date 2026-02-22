// Agent status with new analyzing state
export type AgentStatus = 'idle' | 'analyzing' | 'waiting' | 'working';

export interface OptionChoice {
  action: string;
  keys: string[];
  description?: string;
}

export interface PotentialHarm {
  hasRisk: boolean;
  description?: string;
}

export interface DmuxPane {
  id: string;
  slug: string;
  branchName?: string; // Git branch name (may differ from slug when branchPrefix is set)
  prompt: string;
  paneId: string;
  projectRoot?: string; // Main repository root this pane belongs to
  projectName?: string; // Display name for pane's project
  type?: 'worktree' | 'shell';  // Type of pane (defaults to 'worktree' for backward compat)
  shellType?: string;  // Shell type for shell panes (bash, zsh, fish, etc)
  worktreePath?: string;
  testWindowId?: string;  // Background window for tests
  testStatus?: 'running' | 'passed' | 'failed';
  testOutput?: string;
  devWindowId?: string;   // Background window for dev server
  devStatus?: 'running' | 'stopped';
  devUrl?: string;        // Detected dev server URL
  agent?: 'claude' | 'opencode' | 'codex';
  agentStatus?: AgentStatus;  // Agent working/attention status
  lastAgentCheck?: number;  // Timestamp of last status check
  lastDeterministicStatus?: 'ambiguous' | 'working';  // For LLM detection coordination
  llmRequestId?: string;  // Track active LLM request
  // Options dialog data (when agentStatus is 'waiting')
  optionsQuestion?: string;
  options?: OptionChoice[];
  potentialHarm?: PotentialHarm;
  // Summary of what agent said (when agentStatus is 'idle')
  agentSummary?: string;
  // Autopilot mode - automatically accept options when no risk detected
  autopilot?: boolean;
  // Error message if pane analyzer encounters issues
  analyzerError?: string;
}

export interface PanePosition {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowDimensions {
  width: number;
  height: number;
}

export interface ProjectSettings {
  testCommand?: string;
  devCommand?: string;
  firstTestRun?: boolean;  // Track if test has been run before
  firstDevRun?: boolean;   // Track if dev has been run before
}

export interface DmuxSettings {
  // Agent permission mode
  // '' = agent default behavior (usually prompts for permissions)
  // plan = Claude plan mode only (read/plan focused)
  // acceptEdits = edit files without asking, ask for command execution
  // bypassPermissions = fully autonomous mode (dangerous)
  permissionMode?: '' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  // Autopilot settings
  enableAutopilotByDefault?: boolean;
  // Agent selection
  defaultAgent?: 'claude' | 'opencode' | 'codex';
  // Slug generation provider
  slugProvider?: 'auto' | 'openrouter' | 'claude' | 'codex';
  // OpenRouter API key (persisted to shell config)
  openrouterApiKey?: string;
  // Tmux hooks for event-driven updates (low CPU)
  // true = use hooks, false = use polling, undefined = not yet asked
  useTmuxHooks?: boolean;
  // Base branch for new worktrees (e.g. 'main', 'master', 'develop')
  // When set, worktrees branch from this instead of the current HEAD
  baseBranch?: string;
  // Prefix for branch names (e.g. 'feat/' produces 'feat/fix-auth')
  branchPrefix?: string;
}

export type SettingsScope = 'global' | 'project';

export interface SettingDefinition {
  key: keyof DmuxSettings | string;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'text' | 'action';
  options?: Array<{ value: string; label: string }>;
}

export interface DmuxAppProps {
  panesFile: string;
  projectName: string;
  sessionName: string;
  projectRoot?: string;
  settingsFile: string;
  autoUpdater?: any; // AutoUpdater instance
  controlPaneId?: string; // Pane ID running dmux TUI (left sidebar)
}

export interface DmuxConfig {
  projectName: string;
  projectRoot: string;
  panes: DmuxPane[];
  settings: DmuxSettings;
  lastUpdated: string;
  controlPaneId?: string; // Pane ID running dmux TUI (left sidebar)
  controlPaneSize?: number; // Fixed sidebar width (40 chars)
  welcomePaneId?: string; // Pane ID for the welcome/placeholder pane
}

// Hook types - re-exported from hooks utility for convenience
export type {
  HookType,
  HookEnvironment,
} from './utils/hooks.js';

// Log types - re-exported from LogService for convenience
export type {
  LogLevel,
  LogEntry,
} from './services/LogService.js';
