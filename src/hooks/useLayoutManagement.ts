import { useEffect, useRef } from 'react';
import { enforceControlPaneSize } from '../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../utils/layoutManager.js';
import { LogService } from '../services/LogService.js';

interface LayoutManagementOptions {
  controlPaneId: string | undefined;
  hasActiveDialog: boolean;
}

/**
 * Manages periodic enforcement of control pane (sidebar) size
 * Ensures the sidebar stays at SIDEBAR_WIDTH (40 chars) even after terminal resizes
 */
export function useLayoutManagement({
  controlPaneId,
  hasActiveDialog,
}: LayoutManagementOptions) {
  // Use refs to track state across resize events
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isApplyingLayoutRef = useRef(false);
  // Track if component is still mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    if (!controlPaneId) {
      return; // No sidebar layout configured
    }

    // Enforce sidebar width immediately on mount (with error handling)
    enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH).catch(error => {
      LogService.getInstance().warn(
        `Initial layout enforcement failed: ${error}`,
        'ResizeDebug'
      );
    });

    const handleResize = () => {
      // Skip if we're already applying a layout (prevents loops and race conditions)
      if (isApplyingLayoutRef.current) {
        return;
      }

      // Clear any pending resize
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }

      // Debounce: wait 500ms after last resize event (prevents excessive recalculations)
      resizeTimeoutRef.current = setTimeout(async () => {
        // Check if component is still mounted
        if (!isMountedRef.current) {
          return;
        }

        // Only enforce if not showing dialogs (to avoid interference)
        if (!hasActiveDialog) {
          // Double-check we're not already applying (race condition protection)
          if (isApplyingLayoutRef.current) {
            return;
          }
          isApplyingLayoutRef.current = true;

          try {
            // Only enforce sidebar width when terminal resizes
            await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);

            // Check if still mounted before updating UI
            if (!isMountedRef.current) {
              return;
            }

          } catch (error) {
            // Log error but don't crash - layout will be retried on next resize
            LogService.getInstance().warn(
              `Layout enforcement failed during resize: ${error}`,
              'ResizeDebug'
            );
          } finally {
            // Reset flag after a brief delay (always reset, even on error)
            setTimeout(() => {
              if (isMountedRef.current) {
                isApplyingLayoutRef.current = false;
              }
            }, 100);
          }
        }
      }, 500);
    };

    // Listen to stdout resize events
    process.stdout.on('resize', handleResize);

    // SIGWINCH and the tmux client-resized SIGUSR1 are handled at process scope
    // in index.ts, which re-emits them as this event. Subscribing to the signals
    // directly from here would be fatal: this effect re-runs on every dialog
    // toggle, and once its cleanup removes the last listener for a signal Node
    // restores the default disposition, which for SIGUSR1 is terminate.
    process.on('dmux-resize-requested' as any, handleResize);

    return () => {
      isMountedRef.current = false;
      process.stdout.off('resize', handleResize);
      process.off('dmux-resize-requested' as any, handleResize);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [controlPaneId, hasActiveDialog]);
}
