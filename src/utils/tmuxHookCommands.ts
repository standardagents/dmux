import { resolveDistPath } from './runtimePaths.js';

/**
 * Escape a value for inclusion in a shell double-quoted string.
 */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\$"`]/g, '\\$&');
}

/**
 * Builds the pane-exited hook command used by dmux.
 *
 * It performs two actions:
 * 1) Best-effort control-pane recovery if the control pane was killed.
 * 2) Notifies the current dmux process via SIGUSR2 for normal pane sync.
 */
export function buildPaneExitedHookCommand(pid: number): string {
  const recoveryScriptPath = resolveDistPath('utils', 'controlPaneRecovery.js');
  const escapedScriptPath = escapeForDoubleQuotes(recoveryScriptPath);
  return `run-shell "DMUX_RECOVERY_EXITED_PANE=#{hook_pane} node \\"${escapedScriptPath}\\" >/dev/null 2>&1; kill -USR2 ${pid} 2>/dev/null || true # dmux-hook"`;
}

/**
 * Same as buildPaneExitedHookCommand, but with an explicit session name.
 * This avoids relying on hook format variables that may vary by tmux version.
 */
export function buildPaneExitedHookCommandForSession(
  pid: number,
  sessionName: string
): string {
  const recoveryScriptPath = resolveDistPath('utils', 'controlPaneRecovery.js');
  const escapedScriptPath = escapeForDoubleQuotes(recoveryScriptPath);
  const encodedSessionName = Buffer.from(sessionName, 'utf-8').toString('base64');

  return `run-shell "DMUX_RECOVERY_SESSION_B64=${encodedSessionName} DMUX_RECOVERY_EXITED_PANE=#{hook_pane} node \\"${escapedScriptPath}\\" >/dev/null 2>&1; kill -USR2 ${pid} 2>/dev/null || true # dmux-hook"`;
}

/**
 * Builds an after-select-pane hook that copies the focused pane's cached border
 * style onto the session immediately. This stays inside tmux so focus changes
 * do not need to wait on a shell subprocess before the active border updates.
 */
export function buildPaneFocusHookCommandForSession(
  sessionName: string,
  pid?: number
): string {
  const escapedSessionName = escapeForDoubleQuotes(sessionName);
  const notifyController = typeof pid === 'number'
    ? `; run-shell -b "kill -USR2 ${pid} 2>/dev/null || true # dmux-hook"`
    : '';

  return `if-shell -F "#{!=:#{@dmux_active_border_style},}" "set-option -F -t \\"${escapedSessionName}\\" pane-active-border-style \\"#{@dmux_active_border_style}\\""${notifyController}`;
}
