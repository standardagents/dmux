/**
 * Standardized Action System for dmux
 *
 * This module defines the core action types and response structures used across
 * all dmux interfaces (TUI, Web UI, Native Apps, etc.). By standardizing action
 * responses, we ensure consistent behavior and UI patterns across all interfaces.
 */

import type { DmuxPane } from '../types.js';

/**
 * Action result types determine what kind of UI response is needed
 */
export type ActionResultType =
  | 'success'           // Action completed successfully, show brief message
  | 'error'             // Action failed, show error message
  | 'confirm'           // Need user confirmation (yes/no)
  | 'choice'            // Need user to select from options
  | 'input'             // Need user text input
  | 'info'              // Informational message, no action needed
  | 'progress'          // Long-running action, show progress
  | 'navigation';       // Navigate to a different view/pane

/**
 * Standard option for choice dialogs
 */
export interface ActionOption {
  id: string;
  label: string;
  description?: string;
  danger?: boolean;      // Highlight as dangerous action (e.g., delete)
  default?: boolean;     // Mark as default choice
}

/**
 * Standard action result returned by all action functions
 */
export interface ActionResult {
  type: ActionResultType;
  message: string;
  title?: string;

  // For 'confirm' type
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => Promise<ActionResult>;
  onCancel?: () => Promise<ActionResult>;

  // For 'choice' type
  options?: ActionOption[];
  onSelect?: (optionId: string) => Promise<ActionResult>;

  // For 'input' type
  placeholder?: string;
  defaultValue?: string;
  onSubmit?: (value: string) => Promise<ActionResult>;

  // For 'progress' type
  progress?: number;      // 0-100, or undefined for indeterminate

  // For 'navigation' type
  targetPaneId?: string;

  // Additional metadata
  data?: any;             // Action-specific data
  dismissable?: boolean;  // Can user dismiss without action?
}

/**
 * Context provided to action functions
 */
export interface ActionContext {
  panes: DmuxPane[];
  currentPaneId?: string;
  sessionName: string;
  projectName: string;
  savePanes: (panes: DmuxPane[]) => Promise<void>;

  // Optional callbacks for specific actions
  onPaneUpdate?: (pane: DmuxPane) => void;
  onPaneRemove?: (paneId: string) => void;
  onActionResult?: (result: ActionResult) => Promise<void>;
}

/**
 * Standard action function signature
 */
export type ActionFunction = (
  pane: DmuxPane,
  context: ActionContext,
  params?: any
) => Promise<ActionResult>;

/**
 * Available pane actions
 */
export enum PaneAction {
  VIEW = 'view',
  CLOSE = 'close',
  MERGE = 'merge',
  RENAME = 'rename',
  DUPLICATE = 'duplicate',
  RUN_TEST = 'run_test',
  RUN_DEV = 'run_dev',
  OPEN_OUTPUT = 'open_output',
  COPY_PATH = 'copy_path',
  OPEN_IN_EDITOR = 'open_in_editor',
  TOGGLE_AUTOPILOT = 'toggle_autopilot',
  ATTACH_AGENT = 'attach_agent',
}

/**
 * Action metadata for UI generation
 */
export interface ActionMetadata {
  id: PaneAction;
  label: string;
  description: string;
  icon?: string;
  shortcut?: string;
  requires?: {
    worktree?: boolean;
    testCommand?: boolean;
    devCommand?: boolean;
    runningProcess?: boolean;
  };
  danger?: boolean;
}

/**
 * Registry of all available actions with metadata
 */
export const ACTION_REGISTRY: Record<PaneAction, ActionMetadata> = {
  [PaneAction.VIEW]: {
    id: PaneAction.VIEW,
    label: 'View',
    description: 'Jump to this pane',
    icon: '👁',
    shortcut: 'j',
  },
  [PaneAction.CLOSE]: {
    id: PaneAction.CLOSE,
    label: 'Close',
    description: 'Close this pane',
    icon: '✕',
    shortcut: 'x',
    danger: true,
  },
  [PaneAction.MERGE]: {
    id: PaneAction.MERGE,
    label: 'Merge',
    description: 'Merge worktree to main branch',
    icon: '⎇',
    shortcut: 'm',
    requires: { worktree: true },
  },
  [PaneAction.RENAME]: {
    id: PaneAction.RENAME,
    label: 'Rename',
    description: 'Rename this pane',
    icon: '✎',
  },
  [PaneAction.DUPLICATE]: {
    id: PaneAction.DUPLICATE,
    label: 'Duplicate',
    description: 'Create a copy of this pane',
    icon: '⎘',
  },
  [PaneAction.RUN_TEST]: {
    id: PaneAction.RUN_TEST,
    label: 'Run Tests',
    description: 'Run test command',
    icon: '🧪',
    shortcut: 't',
    requires: { worktree: true },
  },
  [PaneAction.RUN_DEV]: {
    id: PaneAction.RUN_DEV,
    label: 'Run Dev Server',
    description: 'Start development server',
    icon: '▶',
    shortcut: 'd',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_OUTPUT]: {
    id: PaneAction.OPEN_OUTPUT,
    label: 'Open Output',
    description: 'View test or dev output',
    icon: '📋',
    shortcut: 'o',
    requires: { runningProcess: true },
  },
  [PaneAction.COPY_PATH]: {
    id: PaneAction.COPY_PATH,
    label: 'Copy Path',
    description: 'Copy worktree path to clipboard',
    icon: '📁',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_IN_EDITOR]: {
    id: PaneAction.OPEN_IN_EDITOR,
    label: 'Open in Editor',
    description: 'Open worktree in external editor',
    icon: '✎',
    requires: { worktree: true },
  },
  [PaneAction.TOGGLE_AUTOPILOT]: {
    id: PaneAction.TOGGLE_AUTOPILOT,
    label: 'Toggle Autopilot',
    description: 'Enable/disable automatic option acceptance',
    icon: '🤖',
    requires: { worktree: true },
  },
  [PaneAction.ATTACH_AGENT]: {
    id: PaneAction.ATTACH_AGENT,
    label: 'Attach Agent',
    description: 'Attach another agent to this worktree',
    icon: '+',
    shortcut: 'a',
    requires: { worktree: true },
  },
};

const HIDDEN_MENU_ACTIONS = new Set<PaneAction>([
  PaneAction.DUPLICATE,
  PaneAction.RUN_TEST,
  PaneAction.RUN_DEV,
  PaneAction.ATTACH_AGENT,
]);

/**
 * Get available actions for a pane based on its state
 */
export function getAvailableActions(
  pane: DmuxPane,
  projectSettings?: any
): ActionMetadata[] {
  return Object.values(ACTION_REGISTRY).filter(action => {
    if (HIDDEN_MENU_ACTIONS.has(action.id)) return false;
    if (!action.requires) return true;

    const { worktree, testCommand, devCommand, runningProcess } = action.requires;

    if (worktree && !pane.worktreePath) return false;
    if (testCommand && !projectSettings?.testCommand) return false;
    if (devCommand && !projectSettings?.devCommand) return false;
    if (runningProcess && !pane.testWindowId && !pane.devWindowId) return false;

    return true;
  });
}
