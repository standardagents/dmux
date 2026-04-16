import { execSync } from 'child_process';
import { LogService } from './LogService.js';
import { execAsync } from '../utils/execAsync.js';
import type { PanePosition, WindowDimensions } from '../types.js';

export type PaneListScope = 'window' | 'session';

/**
 * Comprehensive dimension info from a single tmux query
 */
export interface DimensionInfo {
  windowWidth: number;
  windowHeight: number;
  clientWidth: number;
  clientHeight: number;
  statusEnabled: boolean;
  statusFormatLines: number;
}

/**
 * Retry strategy for tmux operations
 * - NONE: No retries (destructive operations like delete, close pane)
 * - FAST: Fast retries for UI operations (max 200ms total)
 * - IDEMPOTENT: Safe to retry read operations
 */
export enum RetryStrategy {
  NONE = 'none',
  FAST = 'fast',
  IDEMPOTENT = 'idempotent',
}

interface RetryConfig {
  strategy: RetryStrategy;
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number; // cap for exponential backoff
}

const RETRY_CONFIGS: Record<RetryStrategy, RetryConfig> = {
  [RetryStrategy.NONE]: { strategy: RetryStrategy.NONE, maxRetries: 0, baseDelay: 0, maxDelay: 0 },
  [RetryStrategy.FAST]: { strategy: RetryStrategy.FAST, maxRetries: 2, baseDelay: 50, maxDelay: 100 },
  [RetryStrategy.IDEMPOTENT]: { strategy: RetryStrategy.IDEMPOTENT, maxRetries: 3, baseDelay: 100, maxDelay: 500 },
};

// Errors that should NEVER be retried
const PERMANENT_ERRORS = [
  'tmux not found',
  'command not found',
  'permission denied',
  'no such session',
  'no session found',
  'can\'t find pane',
  'invalid',
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPermanentError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return PERMANENT_ERRORS.some(pattern => message.includes(pattern));
}

/**
 * Centralized tmux command execution service
 * Provides:
 * - Consistent error handling
 * - Retry logic for transient failures
 * - Logging and debugging
 * - Type-safe tmux operations
 */
export class TmuxService {
  private static instance: TmuxService;
  private logger = LogService.getInstance();

  private constructor() {}

  public static getInstance(): TmuxService {
    if (!TmuxService.instance) {
      TmuxService.instance = new TmuxService();
    }
    return TmuxService.instance;
  }

  /**
   * Execute a tmux command with retry logic
   */
  private async executeWithRetry<T>(
    operation: () => T,
    strategy: RetryStrategy = RetryStrategy.IDEMPOTENT,
    context?: string
  ): Promise<T> {
    const config = RETRY_CONFIGS[strategy];

    if (config.maxRetries === 0) {
      return operation();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        lastError = error;

        // Don't retry permanent errors
        if (isPermanentError(error)) {
          this.logger.debug(
            `Permanent error detected${context ? ` (${context})` : ''}, not retrying`,
            'error',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }

        // Don't sleep on last attempt
        if (attempt < config.maxRetries) {
          const delay = Math.min(config.baseDelay * (attempt + 1), config.maxDelay);
          this.logger.debug(
            `Retry attempt ${attempt + 1}/${config.maxRetries}${context ? ` (${context})` : ''}, waiting ${delay}ms`,
            'debug'
          );
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Execute a synchronous tmux command (most common case)
   * @deprecated Use executeNonBlocking for new code
   */
  private execute(
    command: string,
    options: {
      encoding?: BufferEncoding;
      stdio?: 'pipe' | 'inherit';
      silent?: boolean;
    } = {}
  ): string {
    const { encoding = 'utf-8', stdio = 'pipe', silent = false } = options;

    try {
      const result = execSync(command, {
        encoding,
        stdio,
      });
      return typeof result === 'string' ? result.trim() : '';
    } catch (error) {
      if (!silent) {
        this.logger.debug(
          `tmux command failed: ${command}`,
          'error',
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  }

  /**
   * Execute a tmux command asynchronously (non-blocking)
   * This is the preferred method for new code.
   */
  private async executeNonBlocking(
    command: string,
    options: {
      silent?: boolean;
      timeout?: number;
    } = {}
  ): Promise<string> {
    const { silent = false, timeout = 5000 } = options;

    try {
      return await execAsync(command, { timeout, silent });
    } catch (error) {
      if (!silent) {
        this.logger.debug(
          `tmux command failed: ${command}`,
          'error',
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  }

  private listPanesLines(
    format: string,
    scope: PaneListScope = 'window'
  ): string[] {
    if (scope === 'window') {
      const output = this.execute(`tmux list-panes -F '${format}'`);
      return output.split('\n').filter((line) => line.trim());
    }

    const currentSession = this.execute(`tmux display-message -p "#{session_name}"`);
    const output = this.execute(`tmux list-panes -a -F '#{session_name}|${format}'`);

    return output
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        const delimiterIndex = line.indexOf('|');
        if (delimiterIndex === -1) {
          return [];
        }

        const sessionName = line.slice(0, delimiterIndex);
        if (sessionName !== currentSession) {
          return [];
        }

        return [line.slice(delimiterIndex + 1)];
      });
  }

  // ===== BATCHED QUERIES (Performance optimization) =====

  /**
   * Get all dimension info in a single tmux command.
   * This replaces multiple calls to getWindowDimensions, getTerminalDimensions, etc.
   *
   * Performance: 1 command instead of 4+
   */
  async getAllDimensions(): Promise<DimensionInfo> {
    const output = await this.executeNonBlocking(
      `tmux display-message -p "#{window_width}|#{window_height}|#{client_width}|#{client_height}|#{status}"`
    );
    const [ww, wh, cw, ch, status] = output.split('|');

    // Get status format lines (requires separate command due to newlines)
    let statusFormatLines = 0;
    if (status === 'on') {
      try {
        const formats = await this.executeNonBlocking(
          `tmux show-options -gv status-format`,
          { silent: true }
        );
        statusFormatLines = formats.split('\n').filter(line => line.trim()).length;
      } catch {
        statusFormatLines = 1; // Default assumption
      }
    }

    return {
      windowWidth: parseInt(ww, 10),
      windowHeight: parseInt(wh, 10),
      clientWidth: parseInt(cw, 10),
      clientHeight: parseInt(ch, 10),
      statusEnabled: status === 'on',
      statusFormatLines,
    };
  }

  /**
   * Get all pane info in a single tmux command.
   * Returns pane ID, title, position, and dimensions for all panes.
   *
   * Performance: 1 command instead of N * 3+ (where N = pane count)
   */
  async getAllPaneInfo(
    scope: PaneListScope = 'window'
  ): Promise<Array<PanePosition & { title: string }>> {
    const output = await this.executeNonBlocking(
      scope === 'window'
        ? `tmux list-panes -F '#{pane_id}|#{pane_title}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}'`
        : `tmux list-panes -a -F '#{session_name}|#{pane_id}|#{pane_title}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}'`
    );
    const currentSession = scope === 'session'
      ? await this.executeNonBlocking(`tmux display-message -p "#{session_name}"`)
      : null;

    return output
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        const parts = line.split('|');
        const values = scope === 'session'
          ? (() => {
              const [sessionName, ...rest] = parts;
              return sessionName === currentSession ? rest : null;
            })()
          : parts;

        if (!values || values.length < 6) {
          return [];
        }

        const [paneId, title, left, top, width, height] = values;
        return [{
          paneId,
          title,
          left: parseInt(left, 10),
          top: parseInt(top, 10),
          width: parseInt(width, 10),
          height: parseInt(height, 10),
        }];
      });
  }

  // ===== READ OPERATIONS (IDEMPOTENT - safe to retry) =====

  /**
   * Get current pane ID
   */
  async getCurrentPaneId(): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute('tmux display-message -p "#{pane_id}"');
      },
      RetryStrategy.IDEMPOTENT,
      'getCurrentPaneId'
    );
  }

  /**
   * Get the pane currently selected in the active dmux window.
   *
   * This uses pane_active from list-panes instead of display-message so it
   * reflects tmux focus changes after this process was launched.
   */
  async getActivePaneId(scope: PaneListScope = 'window'): Promise<string | null> {
    return this.executeWithRetry(
      () => {
        const lines = this.listPanesLines('#{pane_id} #{pane_active}', scope);
        const activeLine = lines.find((line) => line.endsWith(' 1'));
        return activeLine ? activeLine.split(' ')[0] : null;
      },
      RetryStrategy.IDEMPOTENT,
      `getActivePaneId(${scope})`
    );
  }

  /**
   * Get current window ID
   */
  async getCurrentWindowId(): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute('tmux display-message -p "#{window_id}"');
      },
      RetryStrategy.IDEMPOTENT,
      'getCurrentWindowId'
    );
  }

  /**
   * Get the window ID for a specific pane
   */
  async getPaneWindowId(paneId: string): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute(`tmux display-message -t '${paneId}' -p '#{window_id}'`);
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneWindowId(${paneId})`
    );
  }

  /**
   * Get current window dimensions
   */
  async getWindowDimensions(): Promise<WindowDimensions> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(
          'tmux display-message -p "#{window_width} #{window_height}"'
        );
        const [width, height] = output.split(' ').map(n => parseInt(n, 10));
        return { width, height };
      },
      RetryStrategy.IDEMPOTENT,
      'getWindowDimensions'
    );
  }

  /**
   * Get current terminal (client) dimensions
   */
  async getTerminalDimensions(): Promise<WindowDimensions> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(
          'tmux display-message -p "#{client_width} #{client_height}"'
        );
        const [width, height] = output.split(' ').map(n => parseInt(n, 10));
        return { width, height };
      },
      RetryStrategy.IDEMPOTENT,
      'getTerminalDimensions'
    );
  }

  /**
   * Get all pane IDs in current window
   */
  async getAllPaneIds(scope: PaneListScope = 'window'): Promise<string[]> {
    return this.executeWithRetry(
      () => {
        return this.listPanesLines('#{pane_id}', scope);
      },
      RetryStrategy.IDEMPOTENT,
      `getAllPaneIds(${scope})`
    );
  }

  /**
   * Get pane count in current window
   */
  async getPaneCount(): Promise<number> {
    return this.executeWithRetry(
      () => {
        const output = this.execute('tmux list-panes | wc -l');
        return parseInt(output, 10);
      },
      RetryStrategy.IDEMPOTENT,
      'getPaneCount'
    );
  }

  /**
   * Get pane positions for all panes
   */
  async getPanePositions(): Promise<PanePosition[]> {
    return this.executeWithRetry(
      () => {
        const output = this.execute(
          `tmux list-panes -F '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'`
        );

        return output.split('\n').map(line => {
          const [paneId, left, top, width, height] = line.split(' ');
          return {
            paneId,
            left: parseInt(left, 10),
            top: parseInt(top, 10),
            width: parseInt(width, 10),
            height: parseInt(height, 10),
          };
        });
      },
      RetryStrategy.IDEMPOTENT,
      'getPanePositions'
    );
  }

  /**
   * Get pane title
   */
  async getPaneTitle(paneId: string): Promise<string> {
    return this.executeWithRetry(
      () => {
        return this.execute(
          `tmux display-message -t '${paneId}' -p '#{pane_title}'`
        );
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneTitle(${paneId})`
    );
  }

  /**
   * Get pane content (capture-pane)
   */
  async getPaneContent(paneId: string, options?: { start?: number; end?: number }): Promise<string> {
    return this.executeWithRetry(
      () => {
        let cmd = `tmux capture-pane -t '${paneId}' -p`;
        if (options?.start !== undefined) {
          cmd += ` -S ${options.start}`;
        }
        if (options?.end !== undefined) {
          cmd += ` -E ${options.end}`;
        }
        return this.execute(cmd);
      },
      RetryStrategy.IDEMPOTENT,
      `getPaneContent(${paneId})`
    );
  }

  /**
   * Check if a pane exists
   */
  async paneExists(paneId: string): Promise<boolean> {
    try {
      const result = await this.executeWithRetry(
        () => {
          const output = this.execute(`tmux display-message -t '${paneId}' -p '#{pane_id}'`, { silent: true });
          return output;
        },
        RetryStrategy.FAST,
        `paneExists(${paneId})`
      );
      // Verify the pane ID is actually returned (not empty)
      // Empty output indicates a zombie pane that exists but has no properties
      return result.trim() === paneId;
    } catch {
      // Expected - pane doesn't exist
      return false;
    }
  }

  /**
   * Get content pane IDs (excludes control pane and spacer panes)
   */
  async getContentPaneIds(controlPaneId: string): Promise<string[]> {
    const allPanes = await this.getAllPaneIds();
    const contentPanes: string[] = [];

    for (const id of allPanes) {
      if (id === controlPaneId) continue;

      try {
        const title = await this.getPaneTitle(id);
        if (title !== 'dmux-spacer') {
          contentPanes.push(id);
        }
      } catch {
        // Include pane if we can't get title
        contentPanes.push(id);
      }
    }

    return contentPanes;
  }

  // ===== WRITE OPERATIONS (careful with retry strategy) =====

  /**
   * Split a pane horizontally
   * Returns the new pane ID
   */
  async splitPane(options: {
    targetPane?: string;
    cwd?: string;
    command?: string;
  } = {}): Promise<string> {
    return this.executeWithRetry(
      () => {
        let cmd = 'tmux split-window -h -P -F \'#{pane_id}\'';

        if (options.targetPane) {
          cmd += ` -t '${options.targetPane}'`;
        }
        if (options.cwd) {
          cmd += ` -c "${options.cwd}"`;
        }
        if (options.command) {
          cmd += ` "${options.command}"`;
        }

        return this.execute(cmd);
      },
      RetryStrategy.FAST, // UI operation, fast retry
      'splitPane'
    );
  }

  /**
   * Resize a pane
   */
  async resizePane(paneId: string, dimensions: { width?: number; height?: number }): Promise<void> {
    await this.executeWithRetry(
      () => {
        if (dimensions.width !== undefined) {
          this.execute(`tmux resize-pane -t '${paneId}' -x ${dimensions.width}`);
        }
        if (dimensions.height !== undefined) {
          this.execute(`tmux resize-pane -t '${paneId}' -y ${dimensions.height}`);
        }
      },
      RetryStrategy.FAST,
      `resizePane(${paneId})`
    );
  }

  /**
   * Resize window
   */
  async resizeWindow(dimensions: { width: number; height: number }): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux resize-window -x ${dimensions.width} -y ${dimensions.height}`);
      },
      RetryStrategy.FAST,
      'resizeWindow'
    );
  }

  /**
   * Select a layout string
   */
  async selectLayout(layoutString: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-layout '${layoutString}'`);
      },
      RetryStrategy.FAST,
      'selectLayout'
    );
  }

  /**
   * Set pane title
   */
  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-pane -t '${paneId}' -T '${title}'`);
      },
      RetryStrategy.FAST,
      `setPaneTitle(${paneId})`
    );
  }

  /**
   * Select a pane (make it active)
   */
  async selectPane(paneId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux select-pane -t '${paneId}'`);
      },
      RetryStrategy.FAST,
      `selectPane(${paneId})`
    );
  }

  /**
   * Get the current foreground command for a pane as reported by tmux.
   */
  async getPaneCurrentCommand(paneId: string): Promise<string> {
    return this.executeWithRetry(
      () =>
        this.execute(`tmux display-message -t '${paneId}' -p '#{pane_current_command}'`).trim(),
      RetryStrategy.FAST,
      `getPaneCurrentCommand(${paneId})`
    );
  }

  /**
   * Set global tmux option
   */
  async setOption(option: string, value: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux set-option -g ${option} ${value}`);
      },
      RetryStrategy.FAST,
      `setOption(${option})`
    );
  }

  /**
   * Send keys to a pane
   * @deprecated Use sendShellCommand() for shell commands or sendTmuxKeys() for tmux keys
   */
  async sendKeys(paneId: string, keys: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t '${paneId}' ${keys}`);
      },
      RetryStrategy.FAST,
      `sendKeys(${paneId})`
    );
  }

  /**
   * Send a shell command to a pane (auto-quotes to preserve spaces)
   *
   * Use this for shell commands like: `claude "my prompt"`, `git status`, etc.
   * The command will be automatically quoted to prevent tmux from splitting on spaces.
   *
   * @example
   * await tmuxService.sendShellCommand(paneId, 'claude "fix the bug" --permission-mode acceptEdits');
   * await tmuxService.sendTmuxKeys(paneId, 'Enter'); // Then send Enter key
   *
   * @param paneId The tmux pane ID (e.g., "%1")
   * @param command The shell command to execute (will be auto-quoted)
   * @see sendTmuxKeys For sending tmux key sequences (Enter, C-l, etc.)
   */
  async sendShellCommand(paneId: string, command: string): Promise<void> {
    // Quote the command to preserve spaces, escaping any single quotes
    const quotedCommand = `'${command.replace(/'/g, "'\\''")}'`;
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t '${paneId}' ${quotedCommand}`);
      },
      RetryStrategy.FAST,
      `sendShellCommand(${paneId})`
    );
  }

  /**
   * Send tmux key sequences to a pane (no quoting)
   *
   * Use this for tmux keys like: Enter, C-l, Escape, Tab, C-c, etc.
   * Keys are sent as-is without quoting.
   *
   * @example
   * await tmuxService.sendShellCommand(paneId, 'git status');
   * await tmuxService.sendTmuxKeys(paneId, 'Enter'); // Execute the command
   *
   * @example
   * await tmuxService.sendTmuxKeys(paneId, 'C-l'); // Clear screen
   *
   * @param paneId The tmux pane ID (e.g., "%1")
   * @param keys The tmux key sequence (Enter, C-l, Escape, etc.)
   * @see sendShellCommand For sending shell commands (auto-quoted)
   */
  async sendTmuxKeys(paneId: string, keys: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux send-keys -t '${paneId}' ${keys}`);
      },
      RetryStrategy.FAST,
      `sendTmuxKeys(${paneId})`
    );
  }

  /**
   * Set a tmux buffer with content
   */
  async setBuffer(bufferName: string, content: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        // Single-quoted shell args preserve backslashes/newlines as-is.
        const escaped = content.replace(/'/g, "'\\''");
        this.execute(`tmux set-buffer -b '${bufferName}' -- '${escaped}'`);
      },
      RetryStrategy.FAST,
      `setBuffer(${bufferName})`
    );
  }

  /**
   * Load a tmux buffer directly from a file path.
   * This avoids shell-escaping large or control-character-heavy payloads.
   */
  async loadBufferFromFile(bufferName: string, filePath: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        const quotedPath = `'${filePath.replace(/'/g, "'\\''")}'`;
        this.execute(`tmux load-buffer -b '${bufferName}' ${quotedPath}`);
      },
      RetryStrategy.FAST,
      `loadBufferFromFile(${bufferName})`
    );
  }

  /**
   * Paste a tmux buffer to a pane
   */
  async pasteBuffer(bufferName: string, paneId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux paste-buffer -b '${bufferName}' -t '${paneId}'`);
      },
      RetryStrategy.FAST,
      `pasteBuffer(${bufferName})`
    );
  }

  /**
   * Delete a tmux buffer
   */
  async deleteBuffer(bufferName: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux delete-buffer -b '${bufferName}'`);
      },
      RetryStrategy.FAST,
      `deleteBuffer(${bufferName})`
    );
  }

  /**
   * Refresh the tmux client (UI operation, optional)
   */
  async refreshClient(): Promise<void> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute('tmux refresh-client', { silent: true });
        },
        RetryStrategy.FAST,
        'refreshClient'
      );
    } catch {
      // Intentionally silent - UI refresh is optional
      this.logger.debug('tmux refresh-client failed (non-critical)', 'debug');
    }
  }

  // ===== DESTRUCTIVE OPERATIONS (NO RETRY) =====

  /**
   * Move a pane into its own detached window.
   * Returns the new window ID.
   */
  async breakPaneToWindow(paneId: string, windowName: string): Promise<string> {
    await this.executeWithRetry(
      () => {
        const escapedWindowName = windowName.replace(/'/g, `'\\''`);
        return this.execute(
          `tmux break-pane -d -P -F '#{window_id}' -s '${paneId}' -n '${escapedWindowName}'`
        );
      },
      RetryStrategy.FAST,
      `breakPaneToWindow(${paneId})`
    );

    const output = await this.executeNonBlocking(
      `tmux display-message -t '${paneId}' -p '#{window_id}'`
    );
    return output.trim();
  }

  /**
   * Join a pane back into the current window via a target pane.
   */
  async joinPaneToTarget(
    sourcePaneId: string,
    targetPaneId: string,
    horizontal: boolean = true
  ): Promise<void> {
    await this.executeWithRetry(
      () => {
        const direction = horizontal ? '-h' : '-v';
        this.execute(
          `tmux join-pane -d ${direction} -s '${sourcePaneId}' -t '${targetPaneId}'`
        );
      },
      RetryStrategy.FAST,
      `joinPaneToTarget(${sourcePaneId})`
    );
  }

  /**
   * Kill a pane (DESTRUCTIVE - no retry)
   * Gracefully handles case where pane doesn't exist (considered success)
   */
  async killPane(paneId: string): Promise<void> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute(`tmux kill-pane -t '${paneId}'`);
        },
        RetryStrategy.NONE, // Destructive operation
        `killPane(${paneId})`
      );
    } catch (error) {
      // If pane doesn't exist, consider it success (already killed)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("can't find pane")) {
        this.logger.debug(`Pane ${paneId} already gone, treating as success`, 'killPane');
        return;
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Respawn a pane with a new command (DESTRUCTIVE - no retry)
   * This kills the existing pane process and starts the provided command.
   */
  async respawnPane(paneId: string, command: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        const quotedCommand = `'${command.replace(/'/g, "'\\''")}'`;
        this.execute(`tmux respawn-pane -k -t '${paneId}' ${quotedCommand}`);
      },
      RetryStrategy.NONE,
      `respawnPane(${paneId})`
    );
  }

  /**
   * Kill a window (DESTRUCTIVE - no retry)
   */
  async killWindow(windowId: string): Promise<void> {
    await this.executeWithRetry(
      () => {
        this.execute(`tmux kill-window -t '${windowId}'`);
      },
      RetryStrategy.NONE, // Destructive operation
      `killWindow(${windowId})`
    );
  }

  /**
   * Create a new window
   * Returns the window ID
   */
  async newWindow(options: {
    name?: string;
    detached?: boolean;
  } = {}): Promise<string> {
    return this.executeWithRetry(
      () => {
        let cmd = 'tmux new-window';
        if (options.detached) {
          cmd += ' -d';
        }
        if (options.name) {
          cmd += ` -n '${options.name}'`;
        }
        cmd += " -P -F '#{window_id}'";
        return this.execute(cmd);
      },
      RetryStrategy.FAST,
      'newWindow'
    );
  }

  /**
   * Join a pane from a window (pulls pane into current window)
   */
  async joinPane(sourceWindowId: string, horizontal: boolean = true): Promise<void> {
    await this.executeWithRetry(
      () => {
        const direction = horizontal ? '-h' : '-v';
        this.execute(`tmux join-pane ${direction} -s '${sourceWindowId}'`);
      },
      RetryStrategy.FAST,
      `joinPane(${sourceWindowId})`
    );
  }

  /**
   * Check if a window exists
   */
  async windowExists(windowId: string): Promise<boolean> {
    try {
      await this.executeWithRetry(
        () => {
          this.execute(`tmux list-windows -F '#{window_id}' | grep -q '${windowId}'`, { silent: true });
          return true;
        },
        RetryStrategy.FAST,
        `windowExists(${windowId})`
      );
      return true;
    } catch {
      return false;
    }
  }

  // ===== SYNCHRONOUS FALLBACKS (for gradual migration) =====

  /**
   * Get window dimensions (sync version for compatibility)
   */
  getWindowDimensionsSync(): WindowDimensions {
    try {
      const output = this.execute(
        'tmux display-message -p "#{window_width} #{window_height}"'
      );
      const [width, height] = output.split(' ').map(n => parseInt(n, 10));
      return { width, height };
    } catch (error) {
      this.logger.warn('Failed to get window dimensions, using fallback', 'TmuxService');
      return { width: 120, height: 40 }; // Fallback dimensions
    }
  }

  /**
   * Get terminal dimensions (sync version for compatibility)
   */
  getTerminalDimensionsSync(): WindowDimensions {
    try {
      const output = this.execute(
        'tmux display-message -p "#{client_width} #{client_height}"'
      );
      const [width, height] = output.split(' ').map(n => parseInt(n, 10));
      return { width, height };
    } catch (error) {
      this.logger.warn('Failed to get terminal dimensions, using fallback', 'TmuxService');
      return { width: 120, height: 40 }; // Fallback dimensions
    }
  }

  /**
   * Get status bar height in lines
   * Returns the number of lines the status bar occupies
   *
   * IMPORTANT DIMENSION RELATIONSHIPS:
   *
   * When window-size is "latest" (automatic):
   *   - tmux automatically manages window size to fit client
   *   - window_height = client_height (tmux handles status bar internally)
   *
   * When window-size is "manual" (dmux uses this):
   *   - You control window dimensions explicitly
   *   - total_terminal = window_height + status_bar_height
   *   - When setting window size: window_height = client_height - status_bar_height
   *
   * Therefore, when calculating layouts in manual mode:
   * - Get client_height (terminal size)
   * - Subtract status bar height to get available window height
   * - Set window to that calculated height
   *
   * @returns Number of lines occupied by status bar (0 if disabled)
   */
  getStatusBarHeightSync(): number {
    try {
      // Check if status bar is enabled
      const statusEnabled = this.execute('tmux display-message -p "#{status}"').trim();
      if (statusEnabled !== 'on') {
        return 0;
      }

      // Count the number of status-format lines
      // Each status-format line adds one line to the status bar height
      const statusFormats = this.execute('tmux show-options -gv status-format');
      const formatLines = statusFormats.split('\n').filter(line => line.trim()).length;

      return formatLines;
    } catch (error) {
      this.logger.debug('Failed to get status bar height, assuming 0', 'TmuxService');
      return 0;
    }
  }

  /**
   * Get comprehensive dimension information for debugging
   * Shows the relationship between terminal, window, and status bar dimensions
   */
  getDimensionInfoSync(): {
    clientWidth: number;
    clientHeight: number;
    windowWidth: number;
    windowHeight: number;
    statusBarHeight: number;
    statusBarEnabled: boolean;
  } {
    const client = this.getTerminalDimensionsSync();
    const window = this.getWindowDimensionsSync();
    const statusBarHeight = this.getStatusBarHeightSync();

    return {
      clientWidth: client.width,
      clientHeight: client.height,
      windowWidth: window.width,
      windowHeight: window.height,
      statusBarHeight,
      statusBarEnabled: statusBarHeight > 0,
    };
  }

  /**
   * Calculate the proper window dimensions for manual window-size mode
   *
   * SINGLE SOURCE OF TRUTH for window dimension calculations.
   *
   * When window-size is "manual", we must subtract the status bar height
   * to prevent terminal scrolling.
   *
   * Formula: windowHeight = terminalHeight - statusBarHeight
   *
   * @returns Calculated window dimensions that fit within the terminal
   */
  calculateWindowDimensions(): WindowDimensions {
    const termDims = this.getTerminalDimensionsSync();
    const statusBarHeight = this.getStatusBarHeightSync();

    // Calculate window height: terminal height - status bar
    const windowHeight = termDims.height - statusBarHeight;

    return {
      width: termDims.width,
      height: windowHeight,
    };
  }

  /**
   * Get all pane IDs (sync version for compatibility)
   */
  getAllPaneIdsSync(): string[] {
    try {
      const output = this.execute('tmux list-panes -F "#{pane_id}"');
      return output.split('\n').filter(id => id.trim());
    } catch (error) {
      this.logger.warn('Failed to get pane IDs, returning empty array', 'TmuxService');
      return [];
    }
  }

  /**
   * Get pane positions (sync version for compatibility)
   */
  getPanePositionsSync(): PanePosition[] {
    try {
      const output = this.execute(
        `tmux list-panes -F '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'`
      );

      return output.split('\n').map(line => {
        const [paneId, left, top, width, height] = line.split(' ');
        return {
          paneId,
          left: parseInt(left, 10),
          top: parseInt(top, 10),
          width: parseInt(width, 10),
          height: parseInt(height, 10),
        };
      });
    } catch (error) {
      this.logger.warn('Failed to get pane positions, returning empty array', 'TmuxService');
      return [];
    }
  }

  /**
   * Get pane title (sync version for compatibility)
   */
  getPaneTitleSync(paneId: string): string {
    try {
      return this.execute(`tmux display-message -t '${paneId}' -p '#{pane_title}'`);
    } catch (error) {
      this.logger.warn(`Failed to get pane title for ${paneId}, returning empty string`, 'TmuxService');
      return '';
    }
  }

  /**
   * Split pane (sync version for compatibility)
   */
  splitPaneSync(options: {
    targetPane?: string;
    cwd?: string;
    command?: string;
  } = {}): string {
    let cmd = 'tmux split-window -h -P -F \'#{pane_id}\'';

    if (options.targetPane) {
      cmd += ` -t '${options.targetPane}'`;
    }
    if (options.cwd) {
      cmd += ` -c "${options.cwd}"`;
    }
    if (options.command) {
      cmd += ` "${options.command}"`;
    }

    return this.execute(cmd);
  }

  /**
   * Refresh client (sync version for compatibility)
   */
  refreshClientSync(): void {
    try {
      this.execute('tmux refresh-client', { silent: true });
    } catch {
      // Intentionally silent - UI refresh is optional
    }
  }

  /**
   * Clear tmux history (sync version for compatibility)
   */
  clearHistorySync(): void {
    try {
      this.execute('tmux clear-history', { silent: true });
    } catch {
      // Intentionally silent - history clearing is optional
    }
  }

  /**
   * Get tmux version string
   */
  getVersionSync(): string {
    try {
      return this.execute('tmux -V');
    } catch (error) {
      this.logger.warn('Failed to get tmux version', 'TmuxService');
      return '';
    }
  }

  /**
   * Get a session option value
   */
  getSessionOptionSync(sessionName: string, option: string): string {
    try {
      return this.execute(`tmux show -t ${sessionName} ${option}`);
    } catch (error) {
      this.logger.warn(`Failed to get session option ${option} for ${sessionName}`, 'TmuxService');
      return '';
    }
  }

  /**
   * Get a global option value
   */
  getGlobalOptionSync(option: string): string {
    try {
      return this.execute(`tmux show-options -gv ${option}`, { silent: true }).trim();
    } catch (error) {
      this.logger.warn(`Failed to get global option ${option}`, 'TmuxService');
      return '';
    }
  }

  /**
   * Set a session option
   */
  setSessionOptionSync(sessionName: string, option: string, value: string): void {
    try {
      this.execute(`tmux set -t ${sessionName} ${option} ${value}`, { silent: true });
    } catch (error) {
      this.logger.warn(`Failed to set session option ${option} for ${sessionName}`, 'TmuxService');
    }
  }

  /**
   * Get current session name (sync version for compatibility)
   */
  getCurrentSessionNameSync(): string {
    try {
      return this.execute('tmux display-message -p "#{session_name}"');
    } catch (error) {
      this.logger.warn('Failed to get current session name', 'TmuxService');
      throw error;
    }
  }

  /**
   * Get current pane ID (sync version for compatibility)
   */
  getCurrentPaneIdSync(): string {
    try {
      return this.execute('tmux display-message -p "#{pane_id}"');
    } catch (error) {
      this.logger.warn('Failed to get current pane ID', 'TmuxService');
      throw error;
    }
  }

  /**
   * Set window option (sync version for compatibility)
   */
  setWindowOptionSync(option: string, value: string): void {
    try {
      this.execute(`tmux set-window-option ${option} ${value}`, { silent: true });
    } catch (error) {
      this.logger.warn(`Failed to set window option ${option}`, 'TmuxService');
    }
  }

  /**
   * Get a pane option value (sync version for compatibility)
   */
  getPaneOptionSync(paneId: string, option: string): string {
    try {
      return this.execute(`tmux show-options -p -v -t '${paneId}' ${option}`, { silent: true }).trim();
    } catch (error) {
      this.logger.warn(`Failed to get pane option ${option} for ${paneId}`, 'TmuxService');
      return '';
    }
  }

  /**
   * Set a pane option (sync version for compatibility)
   */
  setPaneOptionSync(paneId: string, option: string, value: string): void {
    try {
      const escapedValue = value.replace(/'/g, `'\\''`);
      this.execute(
        `tmux set-option -p -t '${paneId}' ${option} '${escapedValue}'`,
        { silent: true }
      );
    } catch (error) {
      this.logger.warn(`Failed to set pane option ${option} for ${paneId}`, 'TmuxService');
    }
  }

  /**
   * Unset a pane option (sync version for compatibility)
   */
  unsetPaneOptionSync(paneId: string, option: string): void {
    try {
      this.execute(`tmux set-option -u -p -t '${paneId}' ${option}`, { silent: true });
    } catch (error) {
      this.logger.warn(`Failed to unset pane option ${option} for ${paneId}`, 'TmuxService');
    }
  }

  /**
   * Select layout by name (sync version for compatibility)
   * Note: Does NOT throw on error - logs warning and returns false instead
   * This prevents crashes during rapid resize events
   */
  selectLayoutSync(layout: string): boolean {
    try {
      this.execute(`tmux select-layout '${layout}'`);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to select layout ${layout}`, 'TmuxService');
      return false;
    }
  }

  /**
   * Resize pane (sync version for compatibility)
   * Note: Does NOT throw on error - logs warning and returns false instead
   * This prevents crashes during rapid resize events
   */
  resizePaneSync(paneId: string, dimensions: { width?: number; height?: number }): boolean {
    try {
      if (dimensions.width !== undefined) {
        this.execute(`tmux resize-pane -t '${paneId}' -x ${dimensions.width}`);
      }
      if (dimensions.height !== undefined) {
        this.execute(`tmux resize-pane -t '${paneId}' -y ${dimensions.height}`);
      }
      return true;
    } catch (error) {
      this.logger.warn(`Failed to resize pane ${paneId}`, 'TmuxService');
      return false;
    }
  }

  /**
   * Resize window (sync version for compatibility)
   * Note: Does NOT throw on error - logs warning and returns false instead
   * This prevents crashes during rapid resize events
   */
  resizeWindowSync(dimensions: { width: number; height: number }): boolean {
    try {
      this.execute(`tmux resize-window -x ${dimensions.width} -y ${dimensions.height}`);
      return true;
    } catch (error) {
      this.logger.warn('Failed to resize window', 'TmuxService');
      return false;
    }
  }

  /**
   * Select pane (sync version for compatibility)
   */
  selectPaneSync(paneId: string): void {
    try {
      this.execute(`tmux select-pane -t '${paneId}'`);
    } catch (error) {
      this.logger.warn(`Failed to select pane ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  /**
   * Set pane title (sync version for compatibility)
   */
  setPaneTitleSync(paneId: string, title: string): void {
    try {
      this.execute(`tmux select-pane -t '${paneId}' -T '${title}'`);
    } catch (error) {
      this.logger.warn(`Failed to set pane title for ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  /**
   * Kill pane (sync version for compatibility)
   */
  killPaneSync(paneId: string): void {
    try {
      this.execute(`tmux kill-pane -t '${paneId}'`);
    } catch (error) {
      this.logger.warn(`Failed to kill pane ${paneId}`, 'TmuxService');
      throw error;
    }
  }

  /**
   * List panes formatted (sync version for compatibility)
   */
  listPanesSync(format?: string): string {
    try {
      const formatStr = format || '#{pane_id}=#{pane_index}';
      return this.execute(`tmux list-panes -F "${formatStr}"`);
    } catch (error) {
      this.logger.warn('Failed to list panes', 'TmuxService');
      return '';
    }
  }

  /**
   * Set global tmux option (sync version for compatibility)
   */
  setGlobalOptionSync(option: string, value: string): void {
    try {
      this.execute(`tmux set-option -g ${option} ${value}`, { silent: true });
    } catch (error) {
      this.logger.warn(`Failed to set global option ${option}`, 'TmuxService');
    }
  }

  /**
   * Get pane width (sync version for compatibility)
   */
  getPaneWidthSync(paneId: string): number {
    try {
      const output = this.execute(`tmux display-message -t '${paneId}' -p '#{pane_width}'`);
      return parseInt(output, 10);
    } catch (error) {
      this.logger.warn(`Failed to get pane width for ${paneId}`, 'TmuxService');
      return 0;
    }
  }

  /**
   * Get current layout string (sync version for compatibility)
   */
  getCurrentLayoutSync(): string {
    try {
      return this.execute('tmux display-message -p "#{window_layout}"');
    } catch (error) {
      this.logger.warn('Failed to get current layout', 'TmuxService');
      return '';
    }
  }
}
