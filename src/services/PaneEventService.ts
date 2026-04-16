/**
 * PaneEventService - Unified interface for pane change detection
 *
 * Provides a consistent API regardless of whether we're using:
 * - Tmux hooks (event-driven, low CPU)
 * - Worker thread polling (fallback, separate thread)
 *
 * The service automatically chooses the best method based on user preference
 * and hook availability.
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { TmuxHookManager } from './TmuxHookManager.js';
import { LogService } from './LogService.js';
import { resolveDistPath } from '../utils/runtimePaths.js';

export type PaneEventMode = 'hooks' | 'polling' | 'disabled';

export interface PaneChangeEvent {
  type: 'panes-changed';
  paneIds?: string[];
  added?: string[];
  removed?: string[];
  timestamp: number;
  source: PaneEventMode;
}

export interface PaneFocusEvent {
  type: 'pane-focus-changed';
  activePaneId?: string | null;
  timestamp: number;
  source: PaneEventMode;
}

interface PaneEventConfig {
  sessionName: string;
  controlPaneId?: string;
  pollInterval?: number; // Only used for polling mode
  preferHooks?: boolean; // User preference for hooks vs polling
}

/**
 * PaneEventService singleton
 *
 * Manages pane change detection using either tmux hooks or worker-based polling.
 */
export class PaneEventService extends EventEmitter {
  private static instance: PaneEventService;
  private logger = LogService.getInstance();
  private hookManager: TmuxHookManager;
  private pollingWorker: Worker | null = null;
  private mode: PaneEventMode = 'disabled';
  private config: PaneEventConfig | null = null;
  private unsubscribeHook: (() => void) | null = null;

  private constructor() {
    super();
    this.hookManager = TmuxHookManager.getInstance();
  }

  static getInstance(): PaneEventService {
    if (!PaneEventService.instance) {
      PaneEventService.instance = new PaneEventService();
    }
    return PaneEventService.instance;
  }

  /**
   * Initialize the service with configuration
   */
  async initialize(config: PaneEventConfig): Promise<void> {
    this.config = config;
    this.hookManager.initialize(config.sessionName);
  }

  /**
   * Start pane event detection
   *
   * @param useHooks - If true, try to use hooks; if false, use polling
   * @returns The mode that was activated
   */
  async start(useHooks: boolean = true): Promise<PaneEventMode> {
    if (!this.config) {
      throw new Error('PaneEventService not initialized');
    }

    // Stop any existing mode
    await this.stop();

    if (useHooks) {
      // Try to use hooks
      const hooksAvailable = await this.hookManager.areHooksInstalled();

      if (hooksAvailable || await this.hookManager.installHooks()) {
        this.mode = 'hooks';
        this.startHookMode();
        this.logger.info('Pane events: Using tmux hooks (low CPU)', 'paneEvents');
        return 'hooks';
      }
    }

    // Fall back to polling
    this.mode = 'polling';
    await this.startPollingMode();
    this.logger.info('Pane events: Using worker polling', 'paneEvents');
    return 'polling';
  }

  /**
   * Start hook-based event detection
   */
  private startHookMode(): void {
    // Subscribe to hook events with debouncing
    this.unsubscribeHook = this.hookManager.onHookTriggered(() => {
      const timestamp = Date.now();
      this.emit('panes-changed', {
        type: 'panes-changed',
        timestamp,
        source: 'hooks',
      } as PaneChangeEvent);
      this.emit('pane-focus-changed', {
        type: 'pane-focus-changed',
        timestamp,
        source: 'hooks',
      } as PaneFocusEvent);
    }, 25); // Keep hook updates responsive while still coalescing rapid tmux signals.
  }

  /**
   * Start worker-based polling
   */
  private async startPollingMode(): Promise<void> {
    if (!this.config) return;

    try {
      const workerPath = resolveDistPath('workers', 'panePollingWorker.js');

      this.pollingWorker = new Worker(workerPath, {
        workerData: {
          sessionName: this.config.sessionName,
          controlPaneId: this.config.controlPaneId,
          pollInterval: this.config.pollInterval || 5000,
        },
      });

      // Handle messages from worker
      this.pollingWorker.on('message', (message) => {
        switch (message.type) {
          case 'panes-changed':
            this.emit('panes-changed', {
              type: 'panes-changed',
              paneIds: message.paneIds,
              added: message.added,
              removed: message.removed,
              timestamp: message.timestamp,
              source: 'polling',
            } as PaneChangeEvent);
            break;

          case 'pane-focus-changed':
            this.emit('pane-focus-changed', {
              type: 'pane-focus-changed',
              activePaneId: message.activePaneId,
              timestamp: message.timestamp,
              source: 'polling',
            } as PaneFocusEvent);
            break;

          case 'error':
            this.logger.debug(`Polling worker error: ${message.message}`, 'paneEvents');
            break;

          case 'started':
            this.logger.debug(`Polling worker started (interval: ${message.pollInterval}ms)`, 'paneEvents');
            break;
        }
      });

      this.pollingWorker.on('error', (error) => {
        this.logger.error(`Polling worker error: ${error.message}`, 'paneEvents');
      });

      this.pollingWorker.on('exit', (code) => {
        if (code !== 0 && this.mode === 'polling') {
          this.logger.warn(`Polling worker exited with code ${code}`, 'paneEvents');
        }
        this.pollingWorker = null;
      });

    } catch (error) {
      this.logger.error(`Failed to start polling worker: ${error}`, 'paneEvents');
      throw error;
    }
  }

  /**
   * Stop pane event detection
   */
  async stop(): Promise<void> {
    // Stop hooks
    if (this.unsubscribeHook) {
      this.unsubscribeHook();
      this.unsubscribeHook = null;
    }

    // Stop polling worker
    if (this.pollingWorker) {
      this.pollingWorker.postMessage({ type: 'stop' });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.pollingWorker?.terminate();
          resolve();
        }, 1000);

        this.pollingWorker?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.pollingWorker = null;
    }

    this.mode = 'disabled';
  }

  /**
   * Get current mode
   */
  getMode(): PaneEventMode {
    return this.mode;
  }

  /**
   * Force an immediate check (useful after user actions)
   */
  forceCheck(): void {
    if (this.mode === 'polling' && this.pollingWorker) {
      this.pollingWorker.postMessage({ type: 'force-poll' });
    } else if (this.mode === 'hooks') {
      // Emit event immediately
      const timestamp = Date.now();
      this.emit('panes-changed', {
        type: 'panes-changed',
        timestamp,
        source: 'hooks',
      } as PaneChangeEvent);
      this.emit('pane-focus-changed', {
        type: 'pane-focus-changed',
        timestamp,
        source: 'hooks',
      } as PaneFocusEvent);
    }
  }

  /**
   * Update polling interval (only affects polling mode)
   */
  setPollingInterval(ms: number): void {
    if (this.config) {
      this.config.pollInterval = ms;
    }
    if (this.pollingWorker) {
      this.pollingWorker.postMessage({ type: 'set-interval', pollInterval: ms });
    }
  }

  /**
   * Check if hooks can be installed
   */
  async canUseHooks(): Promise<boolean> {
    return this.hookManager.areHooksInstalled();
  }

  /**
   * Install hooks (for user action)
   */
  async installHooks(): Promise<boolean> {
    const success = await this.hookManager.installHooks();
    if (success && this.mode === 'polling') {
      // Switch to hooks mode
      await this.start(true);
    }
    return success;
  }

  /**
   * Uninstall hooks (for user action)
   */
  async uninstallHooks(): Promise<boolean> {
    const success = await this.hookManager.uninstallHooks();
    if (success && this.mode === 'hooks') {
      // Switch to polling mode
      await this.start(false);
    }
    return success;
  }

  /**
   * Subscribe to pane change events
   * Returns an unsubscribe function
   */
  onPanesChanged(callback: (event: PaneChangeEvent) => void): () => void {
    this.on('panes-changed', callback);
    return () => this.off('panes-changed', callback);
  }

  /**
   * Subscribe to pane focus events
   * Returns an unsubscribe function
   */
  onPaneFocusChanged(callback: (event: PaneFocusEvent) => void): () => void {
    this.on('pane-focus-changed', callback);
    return () => this.off('pane-focus-changed', callback);
  }

  /**
   * Clean up on shutdown
   */
  async cleanup(): Promise<void> {
    await this.stop();
    await this.hookManager.cleanup();
    this.removeAllListeners();
  }
}

export default PaneEventService.getInstance();
