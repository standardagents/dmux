import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('SettingsManager defaults', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses permissive built-in defaults when no settings files exist', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings()).toMatchObject({
      permissionMode: 'bypassPermissions',
      enableAutopilotByDefault: true,
      promptForGitOptionsOnCreate: false,
      minPaneWidth: 50,
      maxPaneWidth: 80,
      enabledNotificationSounds: ['default-system-sound'],
      showFooterTips: true,
      language: 'en',
      colorTheme: 'orange',
    });
  });

  it('loads and persists valid language settings', async () => {
    const written: Array<{ path: string; data: string }> = [];

    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path.endsWith('.dmux.global.json')),
        readFileSync: vi.fn((path: string) => {
          if (path.endsWith('.dmux.global.json')) {
            return JSON.stringify({ language: 'ja' });
          }
          throw new Error(`Unexpected path: ${path}`);
        }),
        writeFileSync: vi.fn((path: string, data: string) => {
          written.push({ path, data });
        }),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getSettings().language).toBe('ja');

    manager.updateSetting('language', 'en', 'global');
    expect(manager.getSettings().language).toBe('en');
    expect(JSON.parse(written.at(-1)?.data ?? '{}')).toMatchObject({ language: 'en' });
  });

  it('rejects invalid language values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('language', 'fr' as any, 'global')).toThrow(
      'Invalid language'
    );
    expect(() => manager.updateSettings({ language: 'fr' as any }, 'global')).toThrow(
      'Invalid language'
    );
  });

  it('keeps localized setting definitions in parity with canonical definitions', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const {
      SETTING_DEFINITIONS,
      getLocalizedSettingDefinitions,
    } = await import('../src/utils/settingsManager.js');
    const localizedDefinitions = getLocalizedSettingDefinitions();

    expect(localizedDefinitions.map((definition) => definition.key)).toEqual(
      SETTING_DEFINITIONS.map((definition) => definition.key)
    );
    expect(localizedDefinitions.find((definition) => definition.key === 'promptForGitOptionsOnCreate')).toBeDefined();
    expect(localizedDefinitions.find((definition) => definition.key === 'colorTheme')).toBeDefined();
  });

  it('allows overriding promptForGitOptionsOnCreate at project scope', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('promptForGitOptionsOnCreate', true, 'project');
    expect(manager.getSettings().promptForGitOptionsOnCreate).toBe(true);
    expect(manager.getProjectSettings().promptForGitOptionsOnCreate).toBe(true);
  });

  it('allows overriding showFooterTips', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('showFooterTips', false, 'project');
    expect(manager.getSettings().showFooterTips).toBe(false);
  });

  it('allows overriding colorTheme with a valid theme name', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('colorTheme', 'cyan', 'project');
    expect(manager.getSettings().colorTheme).toBe('cyan');
    expect(manager.getProjectSettings().colorTheme).toBe('cyan');
  });

  it('rejects invalid colorTheme values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('colorTheme', 'teal' as any, 'global')).toThrow(
      'Invalid colorTheme'
    );
  });

  it('allows overriding enabledNotificationSounds with valid sound ids', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('enabledNotificationSounds', ['default-system-sound', 'harp'], 'project');
    expect(manager.getSettings().enabledNotificationSounds).toEqual(['default-system-sound', 'harp']);
  });

  it('rejects invalid enabledNotificationSounds values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() =>
      manager.updateSetting('enabledNotificationSounds', ['invalid-sound'] as any, 'global')
    ).toThrow('Invalid enabledNotificationSounds');
  });

  it('allows overriding permissionMode with a valid value', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('permissionMode', 'acceptEdits', 'project');
    expect(manager.getSettings().permissionMode).toBe('acceptEdits');
  });

  it('rejects invalid permissionMode values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('permissionMode', 'fullAuto' as any, 'global')).toThrow(
      'Invalid permissionMode'
    );
  });

  it('stores minPaneWidth globally even when project scope is requested', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('minPaneWidth', 60, 'project')).not.toThrow();
    expect(manager.getSettings().minPaneWidth).toBe(60);
    expect(manager.getGlobalSettings().minPaneWidth).toBe(60);
    expect(manager.getProjectSettings().minPaneWidth).toBeUndefined();
  });

  it('stores maxPaneWidth globally even when project scope is requested', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('maxPaneWidth', 120, 'project')).not.toThrow();
    expect(manager.getSettings().maxPaneWidth).toBe(120);
    expect(manager.getGlobalSettings().maxPaneWidth).toBe(120);
    expect(manager.getProjectSettings().maxPaneWidth).toBeUndefined();
  });

  it('rejects out-of-range maxPaneWidth values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('maxPaneWidth', 10, 'global')).toThrow('Invalid maxPaneWidth');
    expect(() => manager.updateSetting('maxPaneWidth', 500, 'global')).toThrow('Invalid maxPaneWidth');
    expect(() => manager.updateSetting('maxPaneWidth', 99.5, 'global')).toThrow('Invalid maxPaneWidth');
  });

  it('rejects out-of-range minPaneWidth values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('minPaneWidth', 10, 'global')).toThrow('Invalid minPaneWidth');
    expect(() => manager.updateSetting('minPaneWidth', 500, 'global')).toThrow('Invalid minPaneWidth');
    expect(() => manager.updateSetting('minPaneWidth', 99.5, 'global')).toThrow('Invalid minPaneWidth');
  });

  it('updateSettings treats pane width bounds as global-only', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSettings({ minPaneWidth: 60, maxPaneWidth: 130 }, 'project');

    expect(manager.getGlobalSettings().minPaneWidth).toBe(60);
    expect(manager.getGlobalSettings().maxPaneWidth).toBe(130);
    expect(manager.getProjectSettings().minPaneWidth).toBeUndefined();
    expect(manager.getProjectSettings().maxPaneWidth).toBeUndefined();
    expect(manager.getSettings().minPaneWidth).toBe(60);
    expect(manager.getSettings().maxPaneWidth).toBe(130);
  });

  it('clamps maxPaneWidth to minPaneWidth when reducing max below min', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('minPaneWidth', 50, 'global');
    manager.updateSetting('maxPaneWidth', 40, 'global');

    expect(manager.getSettings().minPaneWidth).toBe(50);
    expect(manager.getSettings().maxPaneWidth).toBe(50);
  });

  it('clamps minPaneWidth to maxPaneWidth when increasing min above max', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    manager.updateSetting('maxPaneWidth', 70, 'global');
    manager.updateSetting('minPaneWidth', 90, 'global');

    expect(manager.getSettings().minPaneWidth).toBe(70);
    expect(manager.getSettings().maxPaneWidth).toBe(70);
  });

  it('loads team defaults beneath global and project settings', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: string) => (
          path.endsWith('.dmux.defaults.json')
          || path.endsWith('.dmux.global.json')
          || path.endsWith('/.dmux/settings.json')
        )),
        readFileSync: vi.fn((path: string) => {
          if (path.endsWith('.dmux.defaults.json')) {
            return JSON.stringify({
              defaultAgent: 'codex',
              branchPrefix: 'feat/',
              colorTheme: 'cyan',
            });
          }

          if (path.endsWith('.dmux.global.json')) {
            return JSON.stringify({
              colorTheme: 'red',
            });
          }

          if (path.endsWith('/.dmux/settings.json')) {
            return JSON.stringify({
              branchPrefix: 'fix/',
            });
          }

          throw new Error(`Unexpected path: ${path}`);
        }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getTeamDefaults()).toMatchObject({
      defaultAgent: 'codex',
      branchPrefix: 'feat/',
      colorTheme: 'cyan',
    });
    expect(manager.getSettings()).toMatchObject({
      defaultAgent: 'codex',
      colorTheme: 'red',
      branchPrefix: 'fix/',
    });
    expect(manager.getEffectiveScope('defaultAgent')).toBe('team');
    expect(manager.getEffectiveScope('colorTheme')).toBe('global');
    expect(manager.getEffectiveScope('branchPrefix')).toBe('project');
  });

  it('filters invalid values from team defaults files', async () => {
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path.endsWith('.dmux.defaults.json')),
        readFileSync: vi.fn(() => JSON.stringify({
          permissionMode: 'fullAuto',
          enableAutopilotByDefault: true,
          defaultAgent: 'not-an-agent',
          enabledAgents: ['codex', 'not-an-agent', 123],
          enabledNotificationSounds: ['harp', 'not-a-sound'],
          showFooterTips: 'yes',
          colorTheme: 'teal',
          useTmuxHooks: 'sometimes',
          baseBranch: 'main; rm -rf /',
          branchPrefix: 'fix/',
        })),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getTeamDefaults()).toEqual({
      enableAutopilotByDefault: true,
      enabledAgents: ['codex'],
      enabledNotificationSounds: ['harp'],
      branchPrefix: 'fix/',
    });
    expect(manager.getSettings()).toMatchObject({
      permissionMode: 'bypassPermissions',
      enableAutopilotByDefault: true,
      enabledAgents: ['codex'],
      enabledNotificationSounds: ['harp'],
      showFooterTips: true,
      colorTheme: 'orange',
      branchPrefix: 'fix/',
    });
    expect(manager.getEffectiveScope('permissionMode')).toBeNull();
    expect(manager.getEffectiveScope('branchPrefix')).toBe('team');
  });

  it('ignores malformed team defaults files', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path.endsWith('.dmux.defaults.json')),
        readFileSync: vi.fn(() => '{ invalid json'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(manager.getTeamDefaults()).toEqual({});
    expect(manager.getSettings().permissionMode).toBe('bypassPermissions');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load team defaults:',
      expect.anything()
    );

    consoleError.mockRestore();
  });
});
