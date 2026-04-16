/**
 * Utility for launching tmux popup modals
 * Requires tmux 3.2+
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { POPUP_CONFIG } from '../components/popups/config.js';
import { TmuxService } from '../services/TmuxService.js';
import type { PanePosition } from '../types.js';

export interface PopupOptions {
  width?: number;
  height?: number;
  title?: string;
  themeName?: string;
  // If true, popup is centered. If false, you can provide x/y coordinates
  centered?: boolean;
  x?: number;
  y?: number;
  // Working directory for the popup command
  cwd?: string;
  // Border style - single, double, rounded, heavy, etc.
  borderStyle?: string;
  // Offset from left (e.g., to account for sidebar)
  leftOffset?: number;
  // Offset from top
  topOffset?: number;
}

export interface PopupResult<T> {
  success: boolean;
  data?: T;
  cancelled?: boolean;
  error?: string;
}

export interface PopupHandle<T> {
  pid: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  readyPromise: Promise<void>;
  resultPromise: Promise<PopupResult<T>>;
  kill: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getPaneAnchoredPopupOptions(
  pane: PanePosition,
  popupSize: { width: number; height: number },
  clientSize: { width: number; height: number }
): Pick<PopupOptions, 'centered' | 'x' | 'y' | 'width' | 'height'> {
  const width = Math.min(popupSize.width, clientSize.width);
  const height = Math.min(popupSize.height, clientSize.height);
  const maxX = Math.max(0, clientSize.width - width);
  const maxY = Math.max(0, clientSize.height - height);

  return {
    centered: false,
    width,
    height,
    x: clamp(pane.left + Math.floor((pane.width - width) / 2), 0, maxX),
    y: clamp(pane.top, 0, maxY),
  };
}

const POPUP_READY_POLL_INTERVAL_MS = 25;
const POPUP_READY_TIMEOUT_MS = 4000;

/**
 * Calculate actual popup bounds based on tmux terminal dimensions
 */
function calculatePopupBounds(options: PopupOptions): { x: number; y: number; width: number; height: number } {
  const {
    width = 80,
    height = 20,
    centered = true,
    x,
    y,
    leftOffset = 0,
    topOffset = 0,
  } = options;

  try {
    // Get tmux client dimensions using TmuxService
    const tmuxService = TmuxService.getInstance();
    const { width: clientWidth, height: clientHeight } = tmuxService.getTerminalDimensionsSync();

    let posX: number;
    let posY: number;

    if (!centered && (leftOffset > 0 || topOffset > 0)) {
      posX = leftOffset;
      posY = topOffset;
    } else if (!centered && x !== undefined && y !== undefined) {
      posX = x;
      posY = y;
    } else if (centered && leftOffset > 0) {
      posX = Math.floor((clientWidth - width) / 2) + leftOffset;
      posY = Math.floor((clientHeight - height) / 2) + topOffset;
    } else {
      // Fully centered
      posX = Math.floor((clientWidth - width) / 2);
      posY = Math.floor((clientHeight - height) / 2);
    }

    return { x: posX, y: posY, width, height };
  } catch {
    // Fallback to defaults if we can't get tmux dimensions
    return { x: leftOffset || 0, y: topOffset || 0, width, height };
  }
}

/**
 * Launch a tmux popup modal
 * @param command - Command to run in the popup
 * @param options - Popup display options
 * @returns Promise that resolves when popup closes
 */
export async function launchPopup(
  command: string,
  options: PopupOptions = {}
): Promise<PopupResult<string>> {
  const {
    width = 80,
    height = 20,
    title,
    centered = true,
    x,
    y,
    cwd = process.cwd(),
    borderStyle = 'double',
    leftOffset = 0,
    topOffset = 0,
  } = options;

  // Create a temp file for the result
  const resultFile = path.join(os.tmpdir(), `dmux-popup-${Date.now()}.json`);

  // Build tmux popup command
  const args: string[] = [
    'display-popup',
    '-E', // Close on command exit
    '-w', width.toString(),
    '-h', height.toString(),
    '-d', `"${cwd}"`,
  ];

  // Add border style if supported (tmux 3.2+)
  // Skip if borderStyle is 'none' (we want no tmux border)
  if (borderStyle && borderStyle !== 'none') {
    args.push('-b', borderStyle);
  }

  // Add popup border color (foreground only - respects user's terminal background)
  args.push('-s', `'border-fg=colour${POPUP_CONFIG.tmuxBorderColor}'`);

  // Position: centered or custom
  if (!centered && (leftOffset > 0 || topOffset > 0)) {
    // Absolute positioning with leftOffset/topOffset
    args.push('-x', leftOffset.toString());
    args.push('-y', topOffset.toString());
  } else if (!centered && x !== undefined && y !== undefined) {
    // Absolute positioning with x/y
    args.push('-x', x.toString());
    args.push('-y', y.toString());
  } else if (centered && leftOffset > 0) {
    // Centered with sidebar offset
    args.push('-x', leftOffset.toString());
    args.push('-y', topOffset.toString());
  } else {
    // Fully centered
    args.push('-x', 'C');
    args.push('-y', 'C');
  }

  // Title
  if (title) {
    args.push('-T', `"${title}"`);
  }

  // Escape the command for tmux
  const escapedCommand = command.replace(/'/g, "'\\''");

  const fullCommand = `tmux ${args.join(' ')} '${escapedCommand}'`;

  return new Promise((resolve) => {
    // Launch popup with spawn (non-blocking)
    const child = spawn('sh', ['-c', fullCommand], {
      stdio: 'inherit',
    });

    child.on('close', () => {
      // Read result from temp file
      if (fs.existsSync(resultFile)) {
        try {
          const resultData = fs.readFileSync(resultFile, 'utf-8');
          fs.unlinkSync(resultFile); // Clean up

          try {
            const result = JSON.parse(resultData);
            resolve(result);
          } catch {
            // Not JSON, treat as plain text
            resolve({
              success: true,
              data: resultData,
            });
          }
        } catch (error: any) {
          resolve({
            success: false,
            error: error.message,
          });
        }
      } else {
        // No result file = cancelled
        resolve({
          success: false,
          cancelled: true,
        });
      }
    });

    child.on('error', (error) => {
      // Clean up temp file if it exists
      if (fs.existsSync(resultFile)) {
        fs.unlinkSync(resultFile);
      }

      resolve({
        success: false,
        error: error.message,
      });
    });
  });
}

/**
 * Launch a popup that runs a Node.js script
 * @param scriptPath - Path to the compiled JS script
 * @param args - Arguments to pass to the script
 * @param options - Popup display options
 */
export async function launchNodePopup<T = any>(
  scriptPath: string,
  args: string[] = [],
  options: PopupOptions = {}
): Promise<PopupResult<T>> {
  // Get the result file path that the script will write to
  const resultFile = path.join(os.tmpdir(), `dmux-popup-${Date.now()}.json`);

  // Build node command with proper escaping
  // Escape each argument for shell: replace backslashes, then single quotes
  const escapedArgs = [scriptPath, resultFile, ...args].map(arg => {
    // Escape for shell: replace ' with '\''
    const escaped = arg.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    return `'${escaped}'`;
  });

  const command = `node ${escapedArgs.join(' ')}`;

  return launchPopup(command, options) as Promise<PopupResult<T>>;
}

/**
 * Launch a popup non-blocking (returns handle immediately)
 * @param command - Command to run in the popup
 * @param options - Popup display options
 * @returns Handle with PID, bounds, and result promise
 */
export function launchPopupNonBlocking(
  command: string,
  options: PopupOptions = {}
): PopupHandle<string> {
  const {
    width = 80,
    height = 20,
    title,
    centered = true,
    x,
    y,
    cwd = process.cwd(),
    borderStyle = 'double',
    leftOffset = 0,
    topOffset = 0,
  } = options;

  // Calculate popup bounds
  const bounds = calculatePopupBounds(options);

  // Create a temp file for the result
  const resultFile = path.join(os.tmpdir(), `dmux-popup-${Date.now()}.json`);

  // Build tmux popup command
  const args: string[] = [
    'display-popup',
    '-E', // Close on command exit
    '-w', width.toString(),
    '-h', height.toString(),
    '-d', `"${cwd}"`,
  ];

  // Add border style if supported (tmux 3.2+)
  if (borderStyle && borderStyle !== 'none') {
    args.push('-b', borderStyle);
  }

  // Add popup border color (foreground only - respects user's terminal background)
  args.push('-s', `'border-fg=colour${POPUP_CONFIG.tmuxBorderColor}'`);

  // Position: centered or custom
  if (!centered && (leftOffset > 0 || topOffset > 0)) {
    args.push('-x', leftOffset.toString());
    args.push('-y', topOffset.toString());
  } else if (!centered && x !== undefined && y !== undefined) {
    args.push('-x', x.toString());
    args.push('-y', y.toString());
  } else if (centered && leftOffset > 0) {
    args.push('-x', leftOffset.toString());
    args.push('-y', topOffset.toString());
  } else {
    args.push('-x', 'C');
    args.push('-y', 'C');
  }

  // Title
  if (title) {
    args.push('-T', `"${title}"`);
  }

  // Escape the command for tmux
  const escapedCommand = command.replace(/'/g, "'\\''");
  const fullCommand = `tmux ${args.join(' ')} '${escapedCommand}'`;

  // Launch popup with spawn (non-blocking)
  const child = spawn('sh', ['-c', fullCommand], {
    stdio: 'inherit',
  });

  const resultPromise = new Promise<PopupResult<string>>((resolve) => {
    child.on('close', () => {
      // Small delay to ensure file is written
      setTimeout(() => {
        // Read result from temp file
        if (fs.existsSync(resultFile)) {
          try {
            const resultData = fs.readFileSync(resultFile, 'utf-8');
            fs.unlinkSync(resultFile); // Clean up

            try {
              const result = JSON.parse(resultData);
              resolve(result);
            } catch {
              // Not JSON, treat as plain text
              resolve({
                success: true,
                data: resultData,
              });
            }
          } catch (error: any) {
            resolve({
              success: false,
              error: error.message,
            });
          }
        } else {
          // No result file = cancelled
          console.error(`[popup] Result file not found: ${resultFile}`);
          resolve({
            success: false,
            cancelled: true,
          });
        }
      }, 100); // Wait 100ms for file to be written
    });

    child.on('error', (error) => {
      // Clean up temp file if it exists
      if (fs.existsSync(resultFile)) {
        fs.unlinkSync(resultFile);
      }

      resolve({
        success: false,
        error: error.message,
      });
    });
  });

  return {
    pid: child.pid!,
    bounds,
    readyPromise: Promise.resolve(),
    resultPromise,
    kill: () => {
      try {
        child.kill('SIGTERM');
        // Clean up temp file
        if (fs.existsSync(resultFile)) {
          fs.unlinkSync(resultFile);
        }
      } catch {
        // Ignore errors if process already dead
      }
    },
  };
}

function waitForPopupReady(
  child: ChildProcess,
  readyFile: string
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      clearInterval(pollInterval);
      clearTimeout(timeout);
      if (fs.existsSync(readyFile)) {
        try {
          fs.unlinkSync(readyFile);
        } catch {
          // Ignore cleanup races between the popup process and parent watcher.
        }
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const pollInterval = setInterval(() => {
      if (fs.existsSync(readyFile)) {
        finish();
      }
    }, POPUP_READY_POLL_INTERVAL_MS);

    const timeout = setTimeout(finish, POPUP_READY_TIMEOUT_MS);

    child.once('close', finish);
    child.once('error', finish);
  });
}

/**
 * Launch a Node.js popup non-blocking (returns handle immediately)
 * @param scriptPath - Path to the compiled JS script
 * @param args - Arguments to pass to the script
 * @param options - Popup display options
 * @returns Handle with PID, bounds, and result promise
 */
export function launchNodePopupNonBlocking<T = any>(
  scriptPath: string,
  args: string[] = [],
  options: PopupOptions = {}
): PopupHandle<T> {
  const {
    width = 80,
    height = 20,
    title,
    themeName,
    centered = true,
    x,
    y,
    cwd = process.cwd(),
    borderStyle = 'double',
    leftOffset = 0,
    topOffset = 0,
  } = options;

  // Calculate popup bounds
  const bounds = calculatePopupBounds(options);

  // Get the result file path that the script will write to
  // IMPORTANT: Only create this ONCE - do NOT create it again in child.on('close')
  const resultFile = path.join(os.tmpdir(), `dmux-popup-${Date.now()}.json`);
  const readyFile = path.join(
    os.tmpdir(),
    `dmux-popup-ready-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );

  // Build node command with proper escaping
  const escapedArgs = [scriptPath, resultFile, ...args].map(arg => {
    const escaped = arg.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    return `'${escaped}'`;
  });
  const escapedReadyFile = readyFile
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''");

  const envAssignments = [`DMUX_POPUP_READY_FILE='${escapedReadyFile}'`];
  if (themeName) {
    const escapedThemeName = themeName
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "'\\''");
    envAssignments.push(`DMUX_THEME='${escapedThemeName}'`);
  }

  const command = `${envAssignments.join(' ')} node ${escapedArgs.join(' ')}`;

  // Build tmux popup command
  const tmuxArgs: string[] = [
    'display-popup',
    '-E', // Close on command exit
    '-w', width.toString(),
    '-h', height.toString(),
    '-d', `"${cwd}"`,
  ];

  // Add border style if supported (tmux 3.2+)
  if (borderStyle && borderStyle !== 'none') {
    tmuxArgs.push('-b', borderStyle);
  }

  // Add popup border color (foreground only - respects user's terminal background)
  tmuxArgs.push('-s', `'border-fg=colour${POPUP_CONFIG.tmuxBorderColor}'`);

  // Position: centered or custom
  if (!centered && (leftOffset > 0 || topOffset > 0)) {
    tmuxArgs.push('-x', leftOffset.toString());
    tmuxArgs.push('-y', topOffset.toString());
  } else if (!centered && x !== undefined && y !== undefined) {
    tmuxArgs.push('-x', x.toString());
    tmuxArgs.push('-y', y.toString());
  } else if (centered && leftOffset > 0) {
    tmuxArgs.push('-x', leftOffset.toString());
    tmuxArgs.push('-y', topOffset.toString());
  } else {
    tmuxArgs.push('-x', 'C');
    tmuxArgs.push('-y', 'C');
  }

  // Title
  if (title) {
    tmuxArgs.push('-T', `"${title}"`);
  }

  // Escape the command for tmux
  const escapedCommand = command.replace(/'/g, "'\\''");
  const fullCommand = `tmux ${tmuxArgs.join(' ')} '${escapedCommand}'`;

  // Launch popup with spawn (non-blocking)
  const child = spawn('sh', ['-c', fullCommand], {
    stdio: 'inherit',
  });
  const readyPromise = waitForPopupReady(child, readyFile);

  const resultPromise = new Promise<PopupResult<T>>((resolve) => {
    child.on('close', () => {
      // Small delay to ensure file is written
      setTimeout(() => {
        // Read result from temp file using the SAME resultFile path we passed to the script
        if (fs.existsSync(resultFile)) {
          try {
            const resultData = fs.readFileSync(resultFile, 'utf-8');
            fs.unlinkSync(resultFile); // Clean up

            try {
              const result = JSON.parse(resultData);
              resolve(result);
            } catch {
              // Not JSON, treat as plain text
              resolve({
                success: true,
                data: resultData,
              } as any);
            }
          } catch (error: any) {
            resolve({
              success: false,
              error: error.message,
            });
          }
        } else {
          // No result file = cancelled
          console.error(`[popup] Result file not found: ${resultFile}`);
          resolve({
            success: false,
            cancelled: true,
          });
        }
      }, 100); // Wait 100ms for file to be written
    });

    child.on('error', (error) => {
      // Clean up temp file if it exists
      if (fs.existsSync(resultFile)) {
        fs.unlinkSync(resultFile);
      }

      resolve({
        success: false,
        error: error.message,
      });
    });
  });

  return {
    pid: child.pid!,
    bounds,
    readyPromise,
    resultPromise,
    kill: () => {
      try {
        child.kill('SIGTERM');
        // Clean up temp file
        if (fs.existsSync(resultFile)) {
          fs.unlinkSync(resultFile);
        }
        if (fs.existsSync(readyFile)) {
          fs.unlinkSync(readyFile);
        }
      } catch {
        // Ignore errors if process already dead
      }
    },
  };
}

/**
 * Enable tmux mouse mode for click-outside-to-close popup behavior (session-specific)
 * @param sessionName - The tmux session name to enable mouse mode for
 */
export function ensureMouseMode(sessionName: string): void {
  try {
    const tmuxService = TmuxService.getInstance();

    // Check if mouse mode is already enabled for this session
    const mouseStatus = tmuxService.getSessionOptionSync(sessionName, 'mouse');

    // If mouse is off, enable it for this session only (not global)
    if (mouseStatus.includes('off')) {
      tmuxService.setSessionOptionSync(sessionName, 'mouse', 'on');
    }
  } catch {
    // Ignore errors - might not be in tmux session or session doesn't exist yet
  }
}

/**
 * Check if tmux supports popups (3.2+)
 */
export function supportsPopups(): boolean {
  try {
    const tmuxService = TmuxService.getInstance();
    const version = tmuxService.getVersionSync();

    // Extract version number (e.g., "tmux 3.2" -> "3.2")
    const match = version.match(/tmux (\d+\.\d+)/);
    if (match) {
      const versionNum = parseFloat(match[1]);
      return versionNum >= 3.2;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Standard popup positioning presets for consistent UX
 */
export const POPUP_POSITIONING = {
  /**
   * Standard position: top-left corner, offset from sidebar
   * Use this for most popups (menus, dialogs, forms)
   */
  standard(sidebarWidth: number): Partial<PopupOptions> {
    return {
      centered: false,
      leftOffset: sidebarWidth + 1,
      topOffset: 0,
    };
  },

  /**
   * Centered with sidebar offset
   * Use for important dialogs like new pane creation
   */
  centeredWithSidebar(sidebarWidth: number): Partial<PopupOptions> {
    return {
      centered: true,
      leftOffset: sidebarWidth,
    };
  },

  /**
   * Fully centered (no sidebar consideration)
   * Use only when sidebar doesn't exist or doesn't matter
   */
  fullyCentered(): Partial<PopupOptions> {
    return {
      centered: true,
    };
  },

  /**
   * Large popup that takes up most of the available space
   * Use for logs viewer and other content-heavy popups
   */
  large(sidebarWidth: number, terminalWidth: number, terminalHeight: number): Partial<PopupOptions> {
    return {
      centered: false,
      leftOffset: sidebarWidth + 1,
      topOffset: 0,
      width: Math.min(terminalWidth - sidebarWidth - 2, 100),
      height: Math.floor(terminalHeight * 0.9),
    };
  },

  /**
   * Anchor a popup to the top of a specific pane.
   * Use for focused-pane actions launched from inside the pane.
   */
  overPane(
    pane: PanePosition,
    popupSize: { width: number; height: number },
    clientSize: { width: number; height: number }
  ): Partial<PopupOptions> {
    return getPaneAnchoredPopupOptions(pane, popupSize, clientSize);
  },
};
