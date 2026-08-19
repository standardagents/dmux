import type { AgentName, PermissionMode } from './utils/agentLaunch.js';
import type { NotificationSoundId } from './utils/notificationSounds.js';
import type { SidebarMouseEventSource } from './utils/sidebarMouse.js';

export type DmuxThemeName =
  | 'red'
  | 'blue'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'purple'
  | 'cyan'
  | 'magenta';

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

export interface MergeTargetReference {
  displayName?: string;
  slug?: string;
  branchName: string;
  worktreePath?: string;
}

export interface SidebarProject {
  projectRoot: string;
  projectName: string;
  colorTheme?: DmuxThemeName;
  colorThemeSource?: 'auto' | 'manual';
}

export interface DmuxPane {
  id: string;
  slug: string;
  displayName?: string; // User-facing pane name (independent from worktree slug/branch)
  displayNameSource?: 'auto' | 'human'; // Human names are never replaced by terminal auto-naming
  lastAutoNamedAt?: number; // Last successful automatic terminal rename
  lastAutoNameFingerprint?: string; // Screen content used for the last automatic name
  branchName?: string; // Git branch name (may differ from slug when branchPrefix is set)
  prompt: string;
  paneId: string;
  hidden?: boolean; // Pane is detached from the active dmux window but still running
  projectRoot?: string; // Main repository root this pane belongs to
  projectName?: string; // Display name for pane's project
  colorTheme?: DmuxThemeName; // Cached effective project accent for fast focus/theme switches
  type?: 'worktree' | 'shell';  // Type of pane (defaults to 'worktree' for backward compat)
  shellType?: string;  // Shell type for shell panes (bash, zsh, fish, fb, etc)
  shellCwd?: string; // Last observed cwd, used to restore regular terminal panes
  shellCommand?: string; // Dmux-owned command to relaunch (for example the file browser)
  worktreePath?: string;
  browserPath?: string; // Root path when a shell pane is a dmux file browser
  testWindowId?: string;  // Background window for tests
  testStatus?: 'running' | 'passed' | 'failed';
  testOutput?: string;
  devWindowId?: string;   // Background window for dev server
  devStatus?: 'running' | 'stopped';
  devUrl?: string;        // Detected dev server URL
  agent?: AgentName;
  activeAgent?: AgentName; // Agent process currently observed in this pane
  agentProcessId?: number; // Used to detect a manually launched replacement process
  agentSessionId?: string; // Exact resumable CLI session when discoverable
  lastAgentObservedAt?: number;
  permissionMode?: PermissionMode;
  agentStatus?: AgentStatus;  // Agent working/attention status
  needsAttention?: boolean; // Pane has settled and is waiting on the user
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
  // Goal mode - launch supported agents with a session goal command
  goalMode?: boolean;
  // Error message if pane analyzer encounters issues
  analyzerError?: string;
  // Merge ancestry for sub-worktrees; first entry is the immediate parent target.
  mergeTargetChain?: MergeTargetReference[];
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

export interface InferenceTarget {
  providerId: string;
  modelId: string;
  // Custom OpenAI-compatible providers carry their connection metadata with
  // the selection. API keys remain in the environment/credential store.
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
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
  // Goal mode settings
  enableGoalModeByDefault?: boolean;
  // Native attention notifications and same-window attention flashes
  enableNotifications?: boolean;
  // Agent selection
  defaultAgent?: AgentName | '';
  // Which agents appear in new-pane selection
  enabledAgents?: AgentName[];
  // Which macOS helper notification sounds are eligible for random selection
  enabledNotificationSounds?: NotificationSoundId[];
  // Rotate short dmux tips in the footer
  showFooterTips?: boolean;
  // Accent color theme used across the TUI and welcome pane
  colorTheme?: DmuxThemeName;
  // Tmux hooks for event-driven updates (low CPU)
  // true = use hooks, false = use polling, undefined = not yet asked
  useTmuxHooks?: boolean;
  // Base branch for new worktrees (e.g. 'main', 'master', 'develop')
  // When set, worktrees branch from this instead of the current HEAD
  baseBranch?: string;
  // Prefix for branch names (e.g. 'feat/' produces 'feat/fix-auth')
  branchPrefix?: string;
  // Whether new pane popup should ask for base/branch overrides
  promptForGitOptionsOnCreate?: boolean;
  // Linked child repositories to manage alongside the root repo (newline/comma-delimited relative paths)
  linkedRepoPaths?: string;
  // Preferred minimum content pane width in characters
  minPaneWidth?: number;
  // Preferred maximum content pane width in characters
  maxPaneWidth?: number;
  // Display language ('en' for English, 'ja' for Japanese)
  language?: 'en' | 'ja';
  // Provider/model used for dmux's lightweight inference features.
  inferencePrimary?: InferenceTarget;
  // Optional failover provider/model. null explicitly disables failover.
  inferenceBackup?: InferenceTarget | null;
}

export interface NewPaneInput {
  prompt: string;
  baseBranch?: string;
  branchName?: string;
  goalMode?: boolean;
  linkedRepoPaths?: string[];
}

export type SettingsScope = 'global' | 'project';
export type EffectiveSettingsScope = SettingsScope | 'team';

export interface SettingDefinition {
  key: keyof DmuxSettings | string;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'text' | 'number' | 'action';
  scopeBehavior?: 'choose' | 'session' | 'global' | 'project';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  shiftStep?: number;
}

export interface DmuxAppProps {
  panesFile: string;
  projectName: string;
  sessionName: string;
  projectRoot?: string;
  settingsFile: string;
  autoUpdater?: any; // AutoUpdater instance
  controlPaneId?: string; // Pane ID running dmux TUI (left sidebar)
  mouseEvents?: SidebarMouseEventSource; // Sidebar click/wheel events (mouse sequences are filtered out of Ink's stdin)
  mouseRowBaseline?: number; // Pane history size when the Ink frame was first drawn
}

export interface DmuxConfig {
  projectName: string;
  projectRoot: string;
  panes: DmuxPane[];
  sidebarProjects?: SidebarProject[];
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
