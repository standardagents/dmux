import { describe, expect, it, vi } from 'vitest';
import { PopupManager, type PopupManagerConfig } from '../src/services/PopupManager.js';
import type { AgentName } from '../src/utils/agentLaunch.js';
import type { NotificationSoundId } from '../src/utils/notificationSounds.js';

function createPopupManager(
  enabledNotificationSounds?: NotificationSoundId[]
): PopupManager {
  const config: PopupManagerConfig = {
    sidebarWidth: 40,
    projectRoot: '/tmp/project',
    popupsSupported: true,
    isDevMode: false,
    terminalWidth: 120,
    terminalHeight: 40,
    availableAgents: ['claude'] as AgentName[],
    settingsManager: {
      getSettings: () => ({ enabledNotificationSounds }),
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    projectSettings: {},
    trackProjectActivity: async (work) => await work(),
  };

  return new PopupManager(config, () => {}, () => {});
}

describe('PopupManager launchNotificationSoundsPopup', () => {
  it('passes configured notification sounds as the initial selection', async () => {
    const manager = createPopupManager(['default-system-sound', 'harp']) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: {
        enabledNotificationSounds: ['harp', 'war-horn'],
        scope: 'project',
      },
    });

    const result = await manager.launchNotificationSoundsPopup();

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'notificationSoundsPopup.js',
      [],
      expect.objectContaining({
        width: 76,
        title: 'Notification Sounds',
      }),
      expect.objectContaining({
        enabledNotificationSounds: ['default-system-sound', 'harp'],
        sounds: expect.arrayContaining([
          expect.objectContaining({
            id: 'default-system-sound',
            label: 'Default System Sound',
          }),
          expect.objectContaining({
            id: 'harp',
            label: 'Harp',
          }),
        ]),
      }),
      undefined
    );

    expect(result).toEqual({
      key: 'enabledNotificationSounds',
      value: ['harp', 'war-horn'],
      scope: 'project',
    });
  });

  it('uses the selected project notification settings when opening another project', async () => {
    const manager = createPopupManager(['default-system-sound']) as any;
    manager.checkPopupSupport = vi.fn(() => true);
    manager.getSettingsManager = vi.fn((projectRoot?: string) => ({
      getSettings: () => ({
        enabledNotificationSounds:
          projectRoot === '/tmp/other-project'
            ? ['harp']
            : ['default-system-sound'],
      }),
    }));
    manager.launchPopup = vi.fn().mockResolvedValue({
      success: true,
      data: {
        enabledNotificationSounds: ['harp'],
        scope: 'project',
      },
    });

    await manager.launchNotificationSoundsPopup('/tmp/other-project');

    expect(manager.launchPopup).toHaveBeenCalledWith(
      'notificationSoundsPopup.js',
      [],
      expect.any(Object),
      expect.objectContaining({
        enabledNotificationSounds: ['harp'],
      }),
      '/tmp/other-project'
    );
  });
});
