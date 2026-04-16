import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { sendTmuxShellCommand } from '../src/utils/tmuxSendKeys.js';

describe('sendTmuxShellCommand', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('passes startup commands as a single tmux argument', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const commandWithSpaces = '"/Users/me/Library/Application Support/fnm/bin/dmux"';

    sendTmuxShellCommand('dmux-demo', commandWithSpaces, 'inherit');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', 'dmux-demo', commandWithSpaces, 'Enter'],
      { stdio: 'inherit' }
    );
  });

  it('throws when tmux send-keys fails', () => {
    spawnSyncMock.mockReturnValue({ status: 1 });

    expect(() => sendTmuxShellCommand('dmux-demo', 'dmux')).toThrow(
      'Failed to send tmux command to target dmux-demo'
    );
  });
});
