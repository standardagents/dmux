import { resolveDistPath } from './runtimePaths.js';

/**
 * Escape a value for inclusion in a shell double-quoted string.
 */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\$"`]/g, '\\$&');
}

/**
 * Builds a `kill -SIG<name> <pid>` that first confirms the PID still belongs to
 * this dmux process.
 *
 * tmux hooks outlive the process that installed them whenever dmux dies without
 * running its teardown. PIDs get recycled, so an unguarded hook eventually
 * delivers the signal to an unrelated process — and SIGUSR1's default
 * disposition is terminate, so that process dies on the next resize.
 *
 * The guard matches the full entry-script path rather than the string "dmux",
 * which would also match an editor that happens to have a dmux source file
 * open. If the entry path is unavailable we emit the bare kill: a hook that
 * never fires would be worse than one that can misfire.
 */
export function buildGuardedSignalCommand(pid: number, signal: 'USR1' | 'USR2'): string {
  const kill = `kill -${signal} ${pid} 2>/dev/null || true`;
  const entryPath = process.argv[1];

  if (!entryPath) {
    return kill;
  }

  const quotedEntry = `'${entryPath.replace(/'/g, `'\\''`)}'`;
  return `ps -p ${pid} -o command= 2>/dev/null | grep -qF ${quotedEntry} && ${kill}`;
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
  const notify = escapeForDoubleQuotes(buildGuardedSignalCommand(pid, 'USR2'));
  return `run-shell "DMUX_RECOVERY_EXITED_PANE=#{hook_pane} node \\"${escapedScriptPath}\\" >/dev/null 2>&1; ${notify} # dmux-hook"`;
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
  const notify = escapeForDoubleQuotes(buildGuardedSignalCommand(pid, 'USR2'));

  return `run-shell "DMUX_RECOVERY_SESSION_B64=${encodedSessionName} DMUX_RECOVERY_EXITED_PANE=#{hook_pane} node \\"${escapedScriptPath}\\" >/dev/null 2>&1; ${notify} # dmux-hook"`;
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
    ? `; run-shell -b "${escapeForDoubleQuotes(buildGuardedSignalCommand(pid, 'USR2'))} # dmux-hook"`
    : '';

  return `if-shell -F "#{!=:#{@dmux_active_border_style},}" "set-option -F -t \\"${escapedSessionName}\\" pane-active-border-style \\"#{@dmux_active_border_style}\\""${notifyController}`;
}
