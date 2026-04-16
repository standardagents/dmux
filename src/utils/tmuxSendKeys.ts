import { spawnSync } from 'child_process';

export function sendTmuxShellCommand(
  target: string,
  command: string,
  stdio: 'pipe' | 'inherit' = 'pipe'
): void {
  const result = spawnSync(
    'tmux',
    ['send-keys', '-t', target, command, 'Enter'],
    { stdio }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to send tmux command to target ${target}`);
  }
}
