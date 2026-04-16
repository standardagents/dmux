/**
 * Hook for using the standardized action system in the TUI
 *
 * This hook provides a bridge between the pure action functions
 * and the React state management of the TUI.
 */

import { useState, useCallback, useMemo } from 'react';
import { executeAction, PaneAction, type ActionContext } from '../actions/index.js';
import type { ActionResult } from '../actions/types.js';
import {
  handleActionResult,
  createInitialTUIState,
  type TUIActionState
} from '../adapters/tuiActionHandler.js';
import type { DmuxPane } from '../types.js';
import type { TrackProjectActivity } from '../types/activity.js';

interface UseActionSystemParams {
  panes: DmuxPane[];
  savePanes: (panes: DmuxPane[]) => Promise<void>;
  sessionName: string;
  projectName: string;
  defaultProjectRoot: string;
  onPaneUpdate?: (pane: DmuxPane) => void;
  onPaneRemove?: (paneId: string) => void | Promise<void>;
  onActionResult?: (result: ActionResult) => Promise<void>;
  trackProjectActivity: TrackProjectActivity;

  // Popup launchers (optional - falls back to inline dialogs if not provided)
  popupLaunchers?: {
    launchConfirmPopup?: (
      title: string,
      message: string,
      yesLabel?: string,
      noLabel?: string,
      projectRoot?: string
    ) => Promise<boolean>;
    launchChoicePopup?: (
      title: string,
      message: string,
      options: Array<{id: string, label: string, description?: string, danger?: boolean, default?: boolean}>,
      data?: unknown,
      projectRoot?: string
    ) => Promise<string | null>;
    launchInputPopup?: (
      title: string,
      message: string,
      placeholder?: string,
      defaultValue?: string,
      projectRoot?: string,
      maxVisibleLines?: number
    ) => Promise<string | null>;
    launchPRReviewPopup?: (
      data: {
        title: string;
        message: string;
        defaultValue: string;
        repoPath: string;
        sourceBranch: string;
        targetBranch: string;
        files: string[];
        aiFailed?: boolean;
      },
      projectRoot?: string
    ) => Promise<string | null>;
    launchProgressPopup?: (
      message: string,
      type: 'info' | 'success' | 'error',
      timeout: number,
      projectRoot?: string
    ) => Promise<void>;
  };
}

/**
 * Recursively handles action results with popup interactions
 * Extracted to top-level to avoid nested function complexity
 *
 * @param result - The action result to handle
 * @param popupLaunchers - Available popup launchers
 */
async function handleResultWithPopups(
  result: ActionResult,
  popupLaunchers: UseActionSystemParams['popupLaunchers'],
  projectRoot: string | undefined,
  trackProjectActivity: TrackProjectActivity
): Promise<void> {
  // Handle confirm dialogs
  if (result.type === 'confirm' && popupLaunchers?.launchConfirmPopup) {
    const confirmed = await popupLaunchers.launchConfirmPopup(
      result.title || 'Confirm',
      result.message,
      result.confirmLabel,
      result.cancelLabel,
      projectRoot
    );

    if (confirmed && result.onConfirm) {
      const nextResult = await trackProjectActivity(() => result.onConfirm!(), projectRoot);
      await handleResultWithPopups(nextResult, popupLaunchers, projectRoot, trackProjectActivity);
    } else if (!confirmed && result.onCancel) {
      const nextResult = await trackProjectActivity(() => result.onCancel!(), projectRoot);
      await handleResultWithPopups(nextResult, popupLaunchers, projectRoot, trackProjectActivity);
    }
    return;
  }

  // Handle choice dialogs
  if (result.type === 'choice' && popupLaunchers?.launchChoicePopup) {
    const selectedId = await popupLaunchers.launchChoicePopup(
      result.title || 'Choose',
      result.message,
      result.options || [],
      result.data,
      projectRoot
    );

    if (selectedId && result.onSelect) {
      const nextResult = await trackProjectActivity(
        () => result.onSelect!(selectedId),
        projectRoot
      );
      await handleResultWithPopups(nextResult, popupLaunchers, projectRoot, trackProjectActivity);
    }
    return;
  }

  // Handle input dialogs
  if (result.type === 'input' && popupLaunchers?.launchInputPopup) {
    const inputValue = await popupLaunchers.launchInputPopup(
      result.title || 'Input',
      result.message,
      result.placeholder,
      result.defaultValue,
      projectRoot,
      result.inputMaxVisibleLines
    );

    if (inputValue !== null && result.onSubmit) {
      const nextResult = await trackProjectActivity(
        () => result.onSubmit!(inputValue),
        projectRoot
      );
      await handleResultWithPopups(nextResult, popupLaunchers, projectRoot, trackProjectActivity);
    }
    return;
  }

  // Handle PR review dialogs (editable summary + changed files + diff peek)
  if (result.type === 'pr_review' && popupLaunchers?.launchPRReviewPopup && result.reviewData) {
    const inputValue = await popupLaunchers.launchPRReviewPopup(
      {
        title: result.title || 'Pull Request',
        message: result.message || '',
        defaultValue: result.defaultValue || '',
        repoPath: result.reviewData.repoPath,
        sourceBranch: result.reviewData.sourceBranch,
        targetBranch: result.reviewData.targetBranch,
        files: result.reviewData.files,
        aiFailed: result.reviewData.aiFailed,
      },
      projectRoot
    );

    if (inputValue !== null && result.onSubmit) {
      const nextResult = await trackProjectActivity(
        () => result.onSubmit!(inputValue),
        projectRoot
      );
      await handleResultWithPopups(nextResult, popupLaunchers, projectRoot, trackProjectActivity);
    }
    return;
  }

  // Handle non-interactive results (success, error, info, etc.)
  // Use toast notification for better UX
  const { default: stateManager } = await import('../shared/StateManager.js');
  const type = result.type === 'error' ? 'error' : result.type === 'success' ? 'success' : 'info';
  stateManager.showToast(result.message, type);
}

export default function useActionSystem({
  panes,
  savePanes,
  sessionName,
  projectName,
  defaultProjectRoot,
  onPaneUpdate,
  onPaneRemove,
  onActionResult,
  trackProjectActivity,
  popupLaunchers,
}: UseActionSystemParams) {
  // TUI state for rendering dialogs
  const [actionState, setActionState] = useState<TUIActionState>(createInitialTUIState());

  // Create action context
  const context: ActionContext = useMemo(() => ({
    panes,
    sessionName,
    projectName,
    savePanes,
    onPaneUpdate,
    onPaneRemove,
    onActionResult,
  }), [panes, sessionName, projectName, savePanes, onPaneUpdate, onPaneRemove, onActionResult]);

  // Execute an action and handle the result
  const executeActionWithHandling = useCallback(async (
    actionId: PaneAction,
    pane: DmuxPane,
    params?: any
  ) => {
    const projectRoot = pane.projectRoot || defaultProjectRoot;
    try {
      const result = await trackProjectActivity(
        () => executeAction(actionId, pane, context, params),
        projectRoot
      );

      // If popup launchers are available, handle interactive results with popups
      if (popupLaunchers) {
        await handleResultWithPopups(
          result,
          popupLaunchers,
          projectRoot,
          trackProjectActivity
        );
      } else {
        // Fall back to inline dialogs if popup launchers not available
        handleActionResult(result, actionState, (updates) => {
          setActionState(prev => ({ ...prev, ...updates }));
        });
      }
    } catch (error) {
      // Handle execution errors
      setActionState(prev => ({
        ...prev,
        statusMessage: `Action failed: ${error}`,
        statusType: 'error',
      }));
    }
  }, [context, actionState, defaultProjectRoot, popupLaunchers, trackProjectActivity]);

  // Handle callback execution (for multi-step actions)
  const executeCallback = useCallback(async (
    callback: (() => Promise<ActionResult>) | null,
    options?: { showProgress?: boolean; progressMessage?: string; projectRoot?: string }
  ) => {
    if (!callback) return;

    const showProgress = options?.showProgress !== false; // default true
    const progressMessage = options?.progressMessage || 'Processing...';
    const projectRoot = options?.projectRoot || defaultProjectRoot;

    try {
      // Show progress indicator while executing
      if (showProgress) {
        setActionState(prev => ({
          ...prev,
          showProgressDialog: true,
          progressMessage,
          progressPercent: undefined,
        }));
      }

      const result = await trackProjectActivity(callback, projectRoot);

      // Hide progress
      if (showProgress) {
        setActionState(prev => ({
          ...prev,
          showProgressDialog: false,
        }));
      }

      // Handle the result (may trigger more dialogs)
      if (popupLaunchers) {
        await handleResultWithPopups(
          result,
          popupLaunchers,
          projectRoot,
          trackProjectActivity
        );
      } else {
        handleActionResult(result, actionState, (updates) => {
          setActionState(prev => ({ ...prev, ...updates }));
        });
      }
    } catch (error) {
      // Hide progress and show error
      setActionState(prev => ({
        ...prev,
        showProgressDialog: false,
        statusMessage: `Operation failed: ${error}`,
        statusType: 'error',
      }));
    }
  }, [actionState, defaultProjectRoot, popupLaunchers, trackProjectActivity]);

  // Clear a specific dialog
  const clearDialog = useCallback((dialogType: keyof TUIActionState) => {
    setActionState(prev => ({
      ...prev,
      [dialogType]: false,
    }));
  }, []);

  // Clear status message
  const clearStatus = useCallback(() => {
    setActionState(prev => ({
      ...prev,
      statusMessage: '',
    }));
  }, []);

  return {
    actionState,
    executeAction: executeActionWithHandling,
    executeCallback,
    clearDialog,
    clearStatus,
    setActionState,
  };
}
