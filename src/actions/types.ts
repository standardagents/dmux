/**
 * Standardized Action System for dmux
 *
 * This module defines the core action types and response structures used across
 * all dmux interfaces (TUI, Web UI, Native Apps, etc.). By standardizing action
 * responses, we ensure consistent behavior and UI patterns across all interfaces.
 */

import type { DmuxPane } from '../types.js';
import {
  getBulkVisibilityAction,
  getProjectVisibilityAction,
  type PaneBulkVisibilityAction,
  type PaneProjectVisibilityAction,
} from '../utils/paneVisibility.js';
import { getPaneProjectRoot } from '../utils/paneProject.js';

/**
 * Action result types determine what kind of UI response is needed
 */
export type ActionResultType =
  | 'success'           // Action completed successfully, show brief message
  | 'error'             // Action failed, show error message
  | 'confirm'           // Need user confirmation (yes/no)
  | 'choice'            // Need user to select from options
  | 'input'             // Need user text input
  | 'pr_review'         // Specialized PR review popup (editable summary + file list + diff peek)
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
  inputMaxVisibleLines?: number;  // If set, input scrolls within this many lines and popup is enlarged

  // For 'pr_review' type (reuses defaultValue for initial summary text and onSubmit for the result)
  reviewData?: {
    repoPath: string;
    sourceBranch: string;
    targetBranch: string;
    files: string[];
    aiFailed?: boolean;
  };

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
  onPaneRemove?: (paneId: string) => void | Promise<void>;
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
  SET_SOURCE = 'set_source',
  CLOSE = 'close',
  MERGE = 'merge',
  CREATE_PR = 'create_pr',
  RENAME = 'rename',
  DUPLICATE = 'duplicate',
  RUN_TEST = 'run_test',
  RUN_DEV = 'run_dev',
  OPEN_OUTPUT = 'open_output',
  COPY_PATH = 'copy_path',
  OPEN_IN_EDITOR = 'open_in_editor',
  TOGGLE_AUTOPILOT = 'toggle_autopilot',
  ATTACH_AGENT = 'attach_agent',
  CREATE_CHILD_WORKTREE = 'create_child_worktree',
  OPEN_TERMINAL_IN_WORKTREE = 'open_terminal_in_worktree',
  OPEN_FILE_BROWSER = 'open_file_browser',
}

/**
 * Action metadata for UI generation
 */
export interface MenuActionMetadata {
  id: string;
  label: string;
  description: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
}

export interface ActionMetadata extends MenuActionMetadata {
  id: PaneAction;
  requires?: {
    worktree?: boolean;
    testCommand?: boolean;
    devCommand?: boolean;
    runningProcess?: boolean;
  };
}

export const TOGGLE_PANE_VISIBILITY_ACTION = 'toggle_visibility';

export type PaneVisibilityMenuActionId =
  | typeof TOGGLE_PANE_VISIBILITY_ACTION
  | PaneBulkVisibilityAction
  | PaneProjectVisibilityAction;

export type PaneMenuActionId = PaneAction | PaneVisibilityMenuActionId;

export interface PaneMenuAction extends MenuActionMetadata {
  id: PaneMenuActionId;
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
  [PaneAction.SET_SOURCE]: {
    id: PaneAction.SET_SOURCE,
    label: '[DEV] Toggle Source (Pane/Root)',
    description: 'Toggle between this pane as source and project root',
    icon: 'S',
    requires: { worktree: true },
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
  [PaneAction.CREATE_PR]: {
    id: PaneAction.CREATE_PR,
    label: 'Create GitHub PR',
    description: 'Push branch and create a pull request on GitHub',
    icon: '⇱',
    shortcut: 'p',
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
  [PaneAction.CREATE_CHILD_WORKTREE]: {
    id: PaneAction.CREATE_CHILD_WORKTREE,
    label: 'Create Child Worktree',
    description: 'Branch a new worktree from this worktree',
    icon: '⑂',
    shortcut: 'b',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_FILE_BROWSER]: {
    id: PaneAction.OPEN_FILE_BROWSER,
    label: 'Browse Files',
    description: 'Open a read-only project file browser in this worktree',
    icon: 'F',
    shortcut: 'f',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_TERMINAL_IN_WORKTREE]: {
    id: PaneAction.OPEN_TERMINAL_IN_WORKTREE,
    label: 'Add Terminal to Worktree',
    description: 'Open a new shell pane in this worktree',
    icon: '⌨',
    shortcut: 'A',
    requires: { worktree: true },
  },
  [PaneAction.ATTACH_AGENT]: {
    id: PaneAction.ATTACH_AGENT,
    label: 'Add Agent to Worktree',
    description: 'Add another agent to this worktree',
    icon: '+',
    shortcut: 'a',
    requires: { worktree: true },
  },
};

const HIDDEN_MENU_ACTIONS = new Set<PaneAction>([
  PaneAction.DUPLICATE,
  PaneAction.RUN_TEST,
  PaneAction.RUN_DEV,
]);

/**
 * Get available actions for a pane based on its state
 */
export function getAvailableActions(
  pane: DmuxPane,
  projectSettings?: any,
  isDevMode: boolean = false
): ActionMetadata[] {
  return Object.values(ACTION_REGISTRY).filter(action => {
    if (HIDDEN_MENU_ACTIONS.has(action.id)) return false;
    if (action.id === PaneAction.SET_SOURCE && !isDevMode) return false;
    if (!action.requires) return true;

    const { worktree, testCommand, devCommand, runningProcess } = action.requires;

    if (worktree && !pane.worktreePath) return false;
    if (testCommand && !projectSettings?.testCommand) return false;
    if (devCommand && !projectSettings?.devCommand) return false;
    if (runningProcess && !pane.testWindowId && !pane.devWindowId) return false;

    return true;
  });
}

function getBulkVisibilityMenuAction(
  action: PaneBulkVisibilityAction
): PaneMenuAction {
  return action === 'hide-others'
    ? {
        id: action,
        label: 'Hide All Other Panes',
        description: 'Hide every pane except this one',
        shortcut: 'H',
      }
    : {
        id: action,
        label: 'Show All Other Panes',
        description: 'Show every hidden pane except this one',
        shortcut: 'H',
      };
}

function getProjectVisibilityMenuAction(
  action: PaneProjectVisibilityAction
): PaneMenuAction {
  return action === 'focus-project'
    ? {
        id: action,
        label: 'Show Only This Project',
        description: 'Show panes from this project and hide the rest',
        shortcut: 'P',
      }
    : {
        id: action,
        label: 'Show All Panes',
        description: 'Show panes from every project',
        shortcut: 'P',
      };
}

export function getPaneMenuActions(
  pane: DmuxPane,
  panes: DmuxPane[],
  projectSettings?: any,
  isDevMode: boolean = false,
  projectRoot: string = pane.projectRoot || ''
): PaneMenuAction[] {
  const actions = getAvailableActions(pane, projectSettings, isDevMode);
  const menuActions: PaneMenuAction[] = [];

  for (const action of actions) {
    menuActions.push(action);

    if (action.id !== PaneAction.VIEW) {
      continue;
    }

    menuActions.push({
      id: TOGGLE_PANE_VISIBILITY_ACTION,
      label: pane.hidden ? 'Show Pane' : 'Hide Pane',
      description: pane.hidden
        ? 'Show this pane in the active window'
        : 'Hide this pane from the active window',
      shortcut: 'h',
    });

    const bulkVisibilityAction = getBulkVisibilityAction(panes, pane);
    if (bulkVisibilityAction) {
      menuActions.push(getBulkVisibilityMenuAction(bulkVisibilityAction));
    }

    const targetProjectRoot = getPaneProjectRoot(pane, projectRoot);
    const projectVisibilityAction = getProjectVisibilityAction(
      panes,
      targetProjectRoot,
      projectRoot
    );
    if (projectVisibilityAction) {
      menuActions.push(getProjectVisibilityMenuAction(projectVisibilityAction));
    }
  }

  return menuActions;
}

export function isPaneAction(actionId: PaneMenuActionId): actionId is PaneAction {
  return Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, actionId);
}
