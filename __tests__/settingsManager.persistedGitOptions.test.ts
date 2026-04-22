import { afterEach, describe, expect, it, vi } from 'vitest';

describe('SettingsManager persisted git options setting', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
  });

  it('loads promptForGitOptionsOnCreate from persisted project settings', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((filePath: string) =>
          String(filePath) === '/tmp/test-project/.dmux/settings.json'
        ),
        readFileSync: vi.fn((filePath: string) => {
          if (String(filePath) === '/tmp/test-project/.dmux/settings.json') {
            return JSON.stringify({ promptForGitOptionsOnCreate: true });
          }
          return '{}';
        }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().promptForGitOptionsOnCreate).toBe(true);
    expect(manager.getProjectSettings().promptForGitOptionsOnCreate).toBe(true);
  });
});
