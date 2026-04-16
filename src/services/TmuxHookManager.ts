/**
 * TmuxHookManager - Manages tmux hooks for event-driven updates
 *
 * Instead of polling every 5 seconds, tmux hooks notify dmux immediately
 * when panes are created, closed, or resized. This reduces CPU usage and
 * improves responsiveness.
 *
 * Hooks are optional - users can decline and fall back to polling.
 */

import { EventEmitter } from 'events';
import { execAsync } from '../utils/execAsync.js';
import {
  buildPaneExitedHookCommandForSession,
  buildPaneFocusHookCommandForSession,
} from '../utils/tmuxHookCommands.js';
import { LogService } from './LogService.js';

export type HookEvent = 'pane-created' | 'pane-closed' | 'pane-resized' | 'pane-focus-changed';

export interface HookStatus {
  installed: boolean;
  hooks: {
    afterSplitWindow: boolean;
    paneExited: boolean;
    clientResized: boolean;
    afterSelectPane: boolean;
  };
}

/**
 * Hook configuration - maps tmux hook names to our events
 */
const HOOK_CONFIG = {
  'after-split-window': 'pane-created',
  'pane-exited': 'pane-closed',
  'client-resized': 'pane-resized',
  'after-select-pane': 'pane-focus-changed',
} as const;

/**
 * TmuxHookManager singleton
 *
 * Manages the lifecycle of tmux hooks and emits events when they fire.
 * Uses Unix signals (SIGUSR2) to receive hook notifications.
 */
export class TmuxHookManager extends EventEmitter {
  private static instance: TmuxHookManager;
  private logger = LogService.getInstance();
  private sessionName: string = '';
  private pid: number = process.pid;
  private hooksInstalled = false;
  private signalHandlerSetup = false;

  private constructor() {
    super();
  }

  static getInstance(): TmuxHookManager {
    if (!TmuxHookManager.instance) {
      TmuxHookManager.instance = new TmuxHookManager();
    }
    return TmuxHookManager.instance;
  }

  /**
   * Initialize the hook manager with the current session
   */
  initialize(sessionName: string): void {
    this.sessionName = sessionName;
    this.setupSignalHandler();
  }

  /**
   * Set up the SIGUSR2 signal handler to receive hook notifications
   */
  private setupSignalHandler(): void {
    if (this.signalHandlerSetup) return;

    process.on('SIGUSR2', () => {
      this.logger.debug('Received SIGUSR2 signal from tmux hook', 'hooks');
      // Emit a generic event - the listener will need to check what changed
      this.emit('hook-triggered');
    });

    this.signalHandlerSetup = true;
    this.logger.debug('SIGUSR2 signal handler set up for tmux hooks', 'hooks');
  }

  /**
   * Check which hooks are currently installed for this session
   */
  async checkHookStatus(): Promise<HookStatus> {
    if (!this.sessionName) {
      return {
        installed: false,
        hooks: {
          afterSplitWindow: false,
          paneExited: false,
          clientResized: false,
          afterSelectPane: false,
        },
      };
    }

    const hooks = {
      afterSplitWindow: false,
      paneExited: false,
      clientResized: false,
      afterSelectPane: false,
    };

    try {
      // Check each hook by trying to show it
      const checkHook = async (hookName: string): Promise<boolean> => {
        try {
          const result = await execAsync(
            `tmux show-hooks -t '${this.sessionName}' 2>/dev/null | grep -q '${hookName}'`,
            { silent: true, timeout: 2000 }
          );
          return true;
        } catch {
          return false;
        }
      };

      // Check all hooks in parallel
      const [afterSplit, paneExit, clientResize, selectPane] = await Promise.all([
        checkHook('after-split-window'),
        checkHook('pane-exited'),
        checkHook('client-resized'),
        checkHook('after-select-pane'),
      ]);

      hooks.afterSplitWindow = afterSplit;
      hooks.paneExited = paneExit;
      hooks.clientResized = clientResize;
      hooks.afterSelectPane = selectPane;

      const installed = afterSplit && paneExit && clientResize && selectPane;

      return { installed, hooks };
    } catch (error) {
      this.logger.debug(`Failed to check hook status: ${error}`, 'hooks');
      return { installed: false, hooks };
    }
  }

  /**
   * Quick check if hooks appear to be installed (fast, for startup)
   */
  async areHooksInstalled(): Promise<boolean> {
    if (!this.sessionName) return false;

    try {
      // Quick check - just look for our signature hook
      await execAsync(
        `tmux show-hooks -t '${this.sessionName}' 2>/dev/null | grep -q 'dmux-hook'`,
        { silent: true, timeout: 1000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install all performance hooks for this session
   */
  async installHooks(): Promise<boolean> {
    if (!this.sessionName) {
      this.logger.error('Cannot install hooks: session name not set', 'hooks');
      return false;
    }

    try {
      // Create hook commands that send SIGUSR2 to this process
      // We add a comment marker so we can identify our hooks later
      const paneExitedHookCommand = buildPaneExitedHookCommandForSession(
        this.pid,
        this.sessionName
      );
      const paneFocusHookCommand = buildPaneFocusHookCommandForSession(
        this.sessionName,
        this.pid
      );
      const hookCommands = [
        // Pane split (new pane created)
        `tmux set-hook -t '${this.sessionName}' after-split-window 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # dmux-hook"'`,
        // Pane closed (includes control-pane recovery if needed)
        `tmux set-hook -t '${this.sessionName}' pane-exited '${paneExitedHookCommand}'`,
        // Window/client resized
        `tmux set-hook -t '${this.sessionName}' client-resized 'run-shell "kill -USR2 ${this.pid} 2>/dev/null || true # dmux-hook"'`,
        // Pane focus changed
        `tmux set-hook -t '${this.sessionName}' after-select-pane '${paneFocusHookCommand}'`,
      ];

      // Install all hooks
      for (const cmd of hookCommands) {
        await execAsync(cmd, { timeout: 2000 });
      }

      this.hooksInstalled = true;
      this.logger.info('Tmux hooks installed successfully', 'hooks');
      return true;
    } catch (error) {
      this.logger.error(`Failed to install hooks: ${error}`, 'hooks');
      return false;
    }
  }

  /**
   * Remove all dmux hooks from this session
   */
  async uninstallHooks(): Promise<boolean> {
    if (!this.sessionName) return false;

    try {
      const unsetCommands = [
        `tmux set-hook -u -t '${this.sessionName}' after-split-window`,
        `tmux set-hook -u -t '${this.sessionName}' pane-exited`,
        `tmux set-hook -u -t '${this.sessionName}' client-resized`,
        `tmux set-hook -u -t '${this.sessionName}' after-select-pane`,
      ];

      // Try to unset each hook (ignore errors - hook might not exist)
      await Promise.all(
        unsetCommands.map(cmd => execAsync(cmd, { silent: true, timeout: 2000 }).catch(() => {}))
      );

      this.hooksInstalled = false;
      this.logger.info('Tmux hooks uninstalled', 'hooks');
      return true;
    } catch (error) {
      this.logger.debug(`Error uninstalling hooks: ${error}`, 'hooks');
      return false;
    }
  }

  /**
   * Check if hooks are currently active
   */
  isActive(): boolean {
    return this.hooksInstalled;
  }

  /**
   * Subscribe to hook events with debouncing
   * Returns an unsubscribe function
   */
  onHookTriggered(callback: () => void, debounceMs: number = 100): () => void {
    let timeoutId: NodeJS.Timeout | null = null;

    const debouncedCallback = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        callback();
        timeoutId = null;
      }, debounceMs);
    };

    this.on('hook-triggered', debouncedCallback);

    // Return unsubscribe function
    return () => {
      this.off('hook-triggered', debouncedCallback);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }

  /**
   * Clean up on shutdown
   */
  async cleanup(): Promise<void> {
    // Optionally uninstall hooks on shutdown
    // For now, we leave them installed so they work across restarts
    this.removeAllListeners();
  }
}

export default TmuxHookManager.getInstance();
