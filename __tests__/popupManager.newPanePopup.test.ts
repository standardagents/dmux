import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PopupManager, type PopupManagerConfig } from '../src/services/PopupManager.js';
import type { AgentName } from '../src/utils/agentLaunch.js';
import { SettingsManager } from '../src/utils/settingsManager.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createPopupManager(
  settings: Record<string, unknown> = {},
  availableAgents: AgentName[] = ['claude']
): PopupManager {
  const config: PopupManagerConfig = {
    sidebarWidth: 40,
    projectRoot: '/tmp/project',
    popupsSupported: true,
    isDevMode: false,
    terminalWidth: 120,
    terminalHeight: 40,
    availableAgents,
    settingsManager: {
      getSettings: () => settings,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    projectSettings: {},
    trackProjectActivity: async (fn: () => Promise<any>) => fn(),
  };

  return new PopupManager(config, () => {}, () => {});
}

describe('PopupManager launchNewPanePopup', () => {
  it('passes git options flag when setting is enabled', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: true, enableGoalModeByDefault: true }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { prompt: 'test prompt', baseBranch: 'develop', branchName: 'feat/LIN-1', goalMode: false },
    });

    const result = await manager.launchNewPanePopup('/tmp/project');

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'newPanePopup.js',
      ['/tmp/project', '1', '1'],
      expect.objectContaining({
        title: '  ✨ New Pane — project  ',
      }),
      undefined,
      '/tmp/project'
    );
    expect(result).toEqual({
      prompt: 'test prompt',
      baseBranch: 'develop',
      branchName: 'feat/LIN-1',
      goalMode: false,
    });
  });

  it('uses selected project settings for git options prompt', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: false }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.getSettingsManager = vi.fn((projectRoot?: string) => ({
      getSettings: () => ({
        promptForGitOptionsOnCreate: projectRoot === '/tmp/other-project',
        enableGoalModeByDefault: projectRoot === '/tmp/other-project',
      }),
    }));
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { prompt: 'project prompt' },
    });

    await manager.launchNewPanePopup('/tmp/other-project');

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'newPanePopup.js',
      ['/tmp/other-project', '1', '1'],
      expect.objectContaining({
        title: '  ✨ New Pane — other-project  ',
      }),
      undefined,
      '/tmp/other-project'
    );
  });

  it('refreshes main project settings before setting the goal mode default', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-popup-settings-'));
    tempDirs.push(tempRoot);

    const staleSettingsManager = new SettingsManager(tempRoot);
    new SettingsManager(tempRoot).updateSetting('enableGoalModeByDefault', true, 'project');

    const config: PopupManagerConfig = {
      sidebarWidth: 40,
      projectRoot: tempRoot,
      popupsSupported: true,
      isDevMode: false,
      terminalWidth: 120,
      terminalHeight: 40,
      availableAgents: ['claude'],
      settingsManager: staleSettingsManager,
      projectSettings: {},
      trackProjectActivity: async (fn) => fn(),
    };
    const manager = new PopupManager(config, () => {}, () => {}) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { prompt: 'prompt' },
    });

    await manager.launchNewPanePopup(tempRoot);

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'newPanePopup.js',
      [tempRoot, '0', '1'],
      expect.any(Object),
      undefined,
      tempRoot
    );
  });

  it('disables git options when caller requests allowGitOptions=false', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: true }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { prompt: 'attach prompt' },
    });

    await manager.launchNewPanePopup('/tmp/project', { allowGitOptions: false });

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'newPanePopup.js',
      ['/tmp/project', '0', '0'],
      expect.any(Object),
      undefined,
      '/tmp/project'
    );
  });

  it('normalizes legacy string payloads for backward compatibility', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: false }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: 'legacy prompt',
    });

    const result = await manager.launchNewPanePopup();

    expect(result).toEqual({ prompt: 'legacy prompt' });
  });

  it('trims empty override fields from popup payload', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: true }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { prompt: 'prompt', baseBranch: '   ', branchName: ' feat/LIN-8 ', goalMode: true },
    });

    const result = await manager.launchNewPanePopup('/tmp/project');

    expect(result).toEqual({
      prompt: 'prompt',
      branchName: 'feat/LIN-8',
      goalMode: true,
    });
  });

  it('normalizes linked nested repo selections from popup payloads', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: true }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: {
        prompt: 'prompt',
        linkedRepoPaths: [' external/web ', 'packages/docs', 'external/web'],
      },
    });

    const result = await manager.launchNewPanePopup('/tmp/project');

    expect(result).toEqual({
      prompt: 'prompt',
      linkedRepoPaths: ['external/web', 'packages/docs'],
    });
  });

  it('returns null for malformed popup payloads', async () => {
    const manager = createPopupManager({ promptForGitOptionsOnCreate: true }) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: { baseBranch: 'develop' },
    });

    const result = await manager.launchNewPanePopup('/tmp/project');

    expect(result).toBeNull();
  });
});
