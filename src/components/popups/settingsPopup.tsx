#!/usr/bin/env node

/**
 * Standalone popup for settings
 * Runs in a tmux popup modal and writes result to a file
 */

import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { readFileSync } from 'fs';
import type { SettingDefinition, DmuxSettings } from '../../types.js';
import {
  DEFAULT_COLOR_THEME_SETTING_KEY,
  SettingsManager,
} from '../../utils/settingsManager.js';
import { enforceControlPaneSize } from '../../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../../utils/layoutManager.js';
import { resolveEnabledAgentsSelection } from '../../utils/agentLaunch.js';
import { resolveNotificationSoundsSelection } from '../../utils/notificationSounds.js';
import { SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY } from '../../utils/sidebarProjects.js';
import { POPUP_CONFIG } from './config.js';
import {
  PopupWrapper,
  writeSuccessAndExit,
  writeCancelAndExit,
} from './shared/index.js';

interface SettingsPopupProps {
  resultFile: string;
  settingDefinitions: SettingDefinition[];
  settings: SettingsPopupValues;
  globalSettings: DmuxSettings;
  projectSettings: DmuxSettings;
  projectRoot: string;
  controlPaneId?: string;
  selectedIndex?: number;
}

interface PendingSettingUpdate {
  key: string;
  value: any;
  scope: 'global' | 'project' | 'session';
}

type SettingsPopupValues = DmuxSettings & Record<string, unknown>;

const THEME_PREVIEW_COLORS: Record<string, string> = {
  red: '#ff5f5f',
  blue: '#5f87ff',
  yellow: '#ffd75f',
  orange: '#ff8700',
  green: '#5fd75f',
  purple: '#af87ff',
  cyan: '#5fd7d7',
  magenta: '#ff5fd7',
};

const SettingsPopupApp: React.FC<SettingsPopupProps> = ({
  resultFile,
  settingDefinitions,
  settings,
  globalSettings,
  projectSettings,
  projectRoot,
  controlPaneId,
  selectedIndex: initialSelectedIndex = 0,
}) => {
  const [mode, setMode] = useState<'list' | 'edit' | 'scope'>('list');
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const [currentSettings, setCurrentSettings] = useState<SettingsPopupValues>({ ...settings });
  const [currentGlobalSettings, setCurrentGlobalSettings] = useState<DmuxSettings>({ ...globalSettings });
  const [currentProjectSettings, setCurrentProjectSettings] = useState<DmuxSettings>({ ...projectSettings });
  const pendingUpdatesRef = useRef<PendingSettingUpdate[]>([]);
  const previewTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingPreviewUpdateRef = useRef<PendingSettingUpdate | null>(null);
  const widthEditBaselineRef = useRef<{ minPaneWidth: number; maxPaneWidth: number } | null>(null);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [editingKey, setEditingKey] = useState<string | undefined>();
  const [editingValueIndex, setEditingValueIndex] = useState(0);
  const [textValue, setTextValue] = useState('');
  const [numberValue, setNumberValue] = useState(0);
  const [scopeIndex, setScopeIndex] = useState(0);
  const { exit } = useApp();

  const currentDef = editingKey ? settingDefinitions.find(d => d.key === editingKey) : null;

  const isTextEditing = mode === 'edit' && currentDef?.type === 'text';

  const getDirectSaveScope = (
    definition: SettingDefinition | null | undefined
  ): 'global' | 'project' | 'session' | null => {
    if (!definition) {
      return null;
    }

    if (
      definition.scopeBehavior === 'global'
      || definition.scopeBehavior === 'project'
      || definition.scopeBehavior === 'session'
    ) {
      return definition.scopeBehavior;
    }

    return null;
  };

  const getOptionColor = (definition: SettingDefinition, optionValue: string, isSelected: boolean): string => {
    if (!isSelected) {
      return 'white';
    }

    if (
      definition.key === DEFAULT_COLOR_THEME_SETTING_KEY
      || definition.key === SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY
    ) {
      return THEME_PREVIEW_COLORS[optionValue] || POPUP_CONFIG.titleColor;
    }

    return POPUP_CONFIG.titleColor;
  };

  const getNumberBounds = (definition: SettingDefinition): { min: number; max: number } => {
    let min = definition.min ?? Number.MIN_SAFE_INTEGER;
    let max = definition.max ?? Number.MAX_SAFE_INTEGER;

    if (definition.key === 'maxPaneWidth' && typeof currentSettings.minPaneWidth === 'number') {
      min = Math.max(min, currentSettings.minPaneWidth);
    }

    if (definition.key === 'minPaneWidth' && typeof currentSettings.maxPaneWidth === 'number') {
      max = Math.min(max, currentSettings.maxPaneWidth);
    }

    if (min > max) {
      min = max;
    }

    return { min, max };
  };

  const clampNumberValue = (value: number, definition: SettingDefinition): number => {
    const bounds = getNumberBounds(definition);
    return Math.max(bounds.min, Math.min(bounds.max, value));
  };

  const resetEditingState = () => {
    setMode('list');
    setEditingKey(undefined);
    setEditingValueIndex(0);
    setTextValue('');
    setNumberValue(0);
    setScopeIndex(0);
  };

  const upsertPendingUpdate = (update: PendingSettingUpdate) => {
    const next = pendingUpdatesRef.current.filter(
      item => !(item.key === update.key && item.scope === update.scope)
    );
    next.push(update);
    pendingUpdatesRef.current = next;
  };

  const applyLocalUpdate = (update: PendingSettingUpdate) => {
    const nextSettings: SettingsPopupValues = { ...currentSettings };
    const nextGlobalSettings: DmuxSettings = { ...currentGlobalSettings };
    const nextProjectSettings: DmuxSettings = { ...currentProjectSettings };

    if (update.key === 'minPaneWidth' || update.key === 'maxPaneWidth') {
      let minPaneWidth = typeof nextSettings.minPaneWidth === 'number' ? nextSettings.minPaneWidth : 50;
      let maxPaneWidth = typeof nextSettings.maxPaneWidth === 'number' ? nextSettings.maxPaneWidth : 80;

      if (update.key === 'minPaneWidth') {
        minPaneWidth = update.value;
      } else {
        maxPaneWidth = update.value;
      }

      if (minPaneWidth > maxPaneWidth) {
        if (update.key === 'minPaneWidth') {
          minPaneWidth = maxPaneWidth;
        } else {
          maxPaneWidth = minPaneWidth;
        }
      }

      nextSettings.minPaneWidth = minPaneWidth;
      nextSettings.maxPaneWidth = maxPaneWidth;
      nextGlobalSettings.minPaneWidth = minPaneWidth;
      nextGlobalSettings.maxPaneWidth = maxPaneWidth;
      delete nextProjectSettings.minPaneWidth;
      delete nextProjectSettings.maxPaneWidth;
    } else {
      (nextSettings as any)[update.key] = update.value;
      if (update.scope === 'global') {
        (nextGlobalSettings as any)[update.key] = update.value;
        delete (nextProjectSettings as any)[update.key];
      } else {
        (nextProjectSettings as any)[update.key] = update.value;
      }
    }

    setCurrentSettings(nextSettings);
    setCurrentGlobalSettings(nextGlobalSettings);
    setCurrentProjectSettings(nextProjectSettings);
  };

  const refreshLayoutPreview = async () => {
    if (!controlPaneId) {
      return;
    }
    try {
      await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH, {
        forceLayout: true,
        suppressLayoutLogs: true,
        disableSpacer: true,
      });
    } catch {
      // Best-effort refresh for preview mode.
    }
  };

  const persistWidthUpdate = async (update: PendingSettingUpdate): Promise<PendingSettingUpdate> => {
    try {
      const manager = new SettingsManager(projectRoot || process.cwd());
      manager.updateSetting(update.key as keyof DmuxSettings, update.value, 'global');
      const merged = manager.getSettings() as SettingsPopupValues;
      setCurrentSettings(merged);
      setCurrentGlobalSettings(manager.getGlobalSettings());
      setCurrentProjectSettings(manager.getProjectSettings());

      const resolvedValue = merged[update.key as keyof DmuxSettings];
      if (typeof resolvedValue === 'number') {
        const resolvedUpdate = {
          ...update,
          value: resolvedValue,
        };
        upsertPendingUpdate(resolvedUpdate);
        await refreshLayoutPreview();
        return resolvedUpdate;
      }
    } catch {
      // Fall back to local application if persistence fails; parent app will retry on close.
      applyLocalUpdate(update);
      upsertPendingUpdate(update);
      await refreshLayoutPreview();
    }

    return update;
  };

  const clearPreviewTimer = () => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  const waitForPersistQueue = async () => {
    try {
      await persistQueueRef.current;
    } catch {
      // Keep queue moving even if an individual preview apply failed.
    }
  };

  const enqueuePersistWidthUpdate = (update: PendingSettingUpdate): Promise<void> => {
    const next = persistQueueRef.current
      .catch(() => {})
      .then(async () => {
        await persistWidthUpdate(update);
      });
    persistQueueRef.current = next;
    return next;
  };

  const queueWidthPreviewUpdate = (update: PendingSettingUpdate) => {
    pendingPreviewUpdateRef.current = update;
    clearPreviewTimer();
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      const pending = pendingPreviewUpdateRef.current;
      pendingPreviewUpdateRef.current = null;
      if (!pending) {
        return;
      }
      void enqueuePersistWidthUpdate(pending);
    }, 250);
  };

  const flushPendingPreviewUpdate = async () => {
    clearPreviewTimer();
    const pending = pendingPreviewUpdateRef.current;
    pendingPreviewUpdateRef.current = null;
    if (!pending) {
      await waitForPersistQueue();
      return;
    }
    await enqueuePersistWidthUpdate(pending);
    await waitForPersistQueue();
  };

  const revertWidthPreview = async () => {
    clearPreviewTimer();
    pendingPreviewUpdateRef.current = null;
    await waitForPersistQueue();
    const baseline = widthEditBaselineRef.current;
    if (!baseline) {
      return;
    }
    widthEditBaselineRef.current = null;

    const hasChanged =
      currentSettings.minPaneWidth !== baseline.minPaneWidth
      || currentSettings.maxPaneWidth !== baseline.maxPaneWidth;
    if (!hasChanged) {
      return;
    }

    try {
      const manager = new SettingsManager(projectRoot || process.cwd());
      manager.updateSettings(
        {
          minPaneWidth: baseline.minPaneWidth,
          maxPaneWidth: baseline.maxPaneWidth,
        },
        'global'
      );
      const merged = manager.getSettings() as SettingsPopupValues;
      setCurrentSettings(merged);
      setCurrentGlobalSettings(manager.getGlobalSettings());
      setCurrentProjectSettings(manager.getProjectSettings());

      if (typeof merged.minPaneWidth === 'number') {
        upsertPendingUpdate({ key: 'minPaneWidth', value: merged.minPaneWidth, scope: 'global' });
      }
      if (typeof merged.maxPaneWidth === 'number') {
        upsertPendingUpdate({ key: 'maxPaneWidth', value: merged.maxPaneWidth, scope: 'global' });
      }
      await refreshLayoutPreview();
    } catch {
      applyLocalUpdate({
        key: 'minPaneWidth',
        value: baseline.minPaneWidth,
        scope: 'global',
      });
      applyLocalUpdate({
        key: 'maxPaneWidth',
        value: baseline.maxPaneWidth,
        scope: 'global',
      });
      upsertPendingUpdate({ key: 'minPaneWidth', value: baseline.minPaneWidth, scope: 'global' });
      upsertPendingUpdate({ key: 'maxPaneWidth', value: baseline.maxPaneWidth, scope: 'global' });
      await refreshLayoutPreview();
    }
  };

  useEffect(() => {
    return () => {
      clearPreviewTimer();
    };
  }, []);

  const writeSuccessWithPendingAndExit = (
    primary: Partial<PendingSettingUpdate> & { action?: string } = {}
  ) => {
    const data: any = { ...primary };
    if (pendingUpdatesRef.current.length > 0) {
      data.updates = pendingUpdatesRef.current;
    }
    writeSuccessAndExit(resultFile, data, exit);
  };

  const getActionSummary = (key: string): string | null => {
    if (key === 'enabledAgents') {
      return `${resolveEnabledAgentsSelection(currentSettings.enabledAgents).length} selected`;
    }

    if (key === 'enabledNotificationSounds') {
      return `${resolveNotificationSoundsSelection(currentSettings.enabledNotificationSounds).length} selected`;
    }

    return null;
  };

  const getCurrentSettingValue = (key: string): unknown => {
    return currentSettings[key];
  };

  useInput((input, key) => {
    // When editing a text field, only handle escape — let TextInput handle everything else
    if (isTextEditing && !key.escape) return;

    const shiftLeftArrowSequence = input === '\u001b[1;2D';
    const shiftRightArrowSequence = input === '\u001b[1;2C';
    const isShiftArrow = key.shift || shiftLeftArrowSequence || shiftRightArrowSequence;
    const isLeftArrow = key.leftArrow || shiftLeftArrowSequence;
    const isRightArrow = key.rightArrow || shiftRightArrowSequence;

    if (key.escape) {
      if (mode === 'list') {
        if (pendingUpdatesRef.current.length > 0) {
          writeSuccessWithPendingAndExit();
        } else {
          // Exit the popup - helper handles result writing
          writeCancelAndExit(resultFile, exit);
        }
      } else {
        if (
          mode === 'edit' &&
          currentDef &&
          currentDef.type === 'number' &&
          (currentDef.key === 'minPaneWidth' || currentDef.key === 'maxPaneWidth')
        ) {
          void (async () => {
            await revertWidthPreview();
            resetEditingState();
          })();
        } else {
          resetEditingState();
        }
      }
    } else if (key.upArrow) {
      if (mode === 'list') {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
      } else if (mode === 'edit') {
        if (currentDef?.type === 'boolean' || currentDef?.type === 'select') {
          setEditingValueIndex(Math.max(0, editingValueIndex - 1));
        }
      } else if (mode === 'scope') {
        setScopeIndex(Math.max(0, scopeIndex - 1));
      }
    } else if (key.downArrow) {
      if (mode === 'list') {
        setSelectedIndex(Math.min(settingDefinitions.length - 1, selectedIndex + 1));
      } else if (mode === 'edit') {
        const currentDef = settingDefinitions.find(d => d.key === editingKey);
        if (currentDef && (currentDef.type === 'boolean' || currentDef.type === 'select')) {
          const maxIndex = currentDef.type === 'boolean' ? 1 : (currentDef.options?.length || 1) - 1;
          setEditingValueIndex(Math.min(maxIndex, editingValueIndex + 1));
        }
      } else if (mode === 'scope') {
        setScopeIndex(Math.min(1, scopeIndex + 1));
      }
    } else if (
      mode === 'edit' &&
      currentDef?.type === 'number' &&
      (isLeftArrow || isRightArrow)
    ) {
      const baseStep = currentDef.step ?? 1;
      const shiftStep = currentDef.shiftStep ?? 10;
      const delta = isRightArrow ? 1 : -1;
      const appliedStep = isShiftArrow ? shiftStep : baseStep;
      setNumberValue((prev) => {
        const nextValue = clampNumberValue(prev + (delta * appliedStep), currentDef);
        if (currentDef.key === 'minPaneWidth' || currentDef.key === 'maxPaneWidth') {
          queueWidthPreviewUpdate({
            key: currentDef.key,
            value: nextValue,
            scope: 'global',
          });
        }
        return nextValue;
      });
    } else if (key.return) {
      if (mode === 'list') {
        const currentDef = settingDefinitions[selectedIndex];

        // Handle action type - return action name
        if (currentDef.type === 'action') {
          writeSuccessWithPendingAndExit({ action: currentDef.key });
          return;
        }

        // Enter edit mode for regular settings
        setEditingKey(currentDef.key);
        setMode('edit');
        if (
          currentDef.type === 'number' &&
          (currentDef.key === 'minPaneWidth' || currentDef.key === 'maxPaneWidth')
        ) {
          widthEditBaselineRef.current = {
            minPaneWidth: typeof currentSettings.minPaneWidth === 'number' ? currentSettings.minPaneWidth : 50,
            maxPaneWidth: typeof currentSettings.maxPaneWidth === 'number' ? currentSettings.maxPaneWidth : 80,
          };
          pendingPreviewUpdateRef.current = null;
          clearPreviewTimer();
        } else {
          widthEditBaselineRef.current = null;
        }
        // Set initial value based on current setting
        const currentValue = getCurrentSettingValue(currentDef.key);
        if (currentDef.type === 'boolean') {
          setEditingValueIndex(currentValue ? 0 : 1);
        } else if (currentDef.type === 'select' && currentDef.options) {
          const optIndex = currentDef.options.findIndex(o => o.value === currentValue);
          setEditingValueIndex(Math.max(0, optIndex));
        } else if (currentDef.type === 'text') {
          setTextValue(typeof currentValue === 'string' ? currentValue : '');
        } else if (currentDef.type === 'number') {
          const initialValue = typeof currentValue === 'number'
            ? currentValue
            : (typeof currentDef.min === 'number' ? currentDef.min : 0);
          setNumberValue(clampNumberValue(initialValue, currentDef));
        }
      } else if (mode === 'edit') {
        // Pane-width bounds are always global - save directly
        if (
          currentDef &&
          currentDef.type === 'number' &&
          (currentDef.key === 'minPaneWidth' || currentDef.key === 'maxPaneWidth')
        ) {
          void (async () => {
            await flushPendingPreviewUpdate();
            await enqueuePersistWidthUpdate({
              key: currentDef.key,
              value: numberValue,
              scope: 'global',
            });
            await waitForPersistQueue();
            widthEditBaselineRef.current = null;
            resetEditingState();
          })();
          return;
        }

        const directSaveScope = getDirectSaveScope(currentDef);
        if (currentDef && directSaveScope) {
          let newValue: any = '';
          if (currentDef.type === 'boolean') {
            newValue = editingValueIndex === 0;
          } else if (currentDef.type === 'select' && currentDef.options) {
            newValue = currentDef.options[editingValueIndex]?.value ?? '';
          } else if (currentDef.type === 'text') {
            newValue = textValue;
          } else if (currentDef.type === 'number') {
            newValue = numberValue;
          }

          writeSuccessWithPendingAndExit({
            key: currentDef.key,
            value: newValue,
            scope: directSaveScope,
          });
          return;
        }

        // Go to scope selection for regular settings
        setMode('scope');
        setScopeIndex(0);
      } else if (mode === 'scope') {
        // Save the setting
        const currentDef = settingDefinitions.find(d => d.key === editingKey);
        if (currentDef && currentDef.type !== 'action') {
          const scope = scopeIndex === 0 ? 'global' : 'project';

          // Calculate the new value
          let newValue: any;
          if (currentDef.type === 'boolean') {
            newValue = editingValueIndex === 0;
          } else if (currentDef.type === 'select' && currentDef.options) {
            newValue = currentDef.options[editingValueIndex]?.value || '';
          } else if (currentDef.type === 'text') {
            newValue = textValue;
          } else if (currentDef.type === 'number') {
            newValue = numberValue;
          }

          writeSuccessWithPendingAndExit({
            key: currentDef.key,
            value: newValue,
            scope,
          });
        }
      }
    }
  });

  return (
    <PopupWrapper resultFile={resultFile} allowEscapeToCancel={false}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {mode === 'list' && (
          <>
            {settingDefinitions.map((def, index) => {
            const isSelected = index === selectedIndex;

            // Handle action type differently - no value display
            if (def.type === 'action') {
              const actionSummary = getActionSummary(def.key);
              return (
                <Box key={def.key}>
                  <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                    {isSelected ? '▶ ' : '  '}
                    {def.label}
                  </Text>
                  <Text color={isSelected ? 'cyan' : 'gray'} dimColor={!isSelected}>
                    {' '}({actionSummary ? `${actionSummary} • ` : ''}press Enter)
                  </Text>
                </Box>
              );
            }

            const currentValue = getCurrentSettingValue(def.key);
            const isProjectOverride = def.key in currentProjectSettings;
            const isGlobalSetting = def.key in currentGlobalSettings;

            let displayValue: string;
            let scopeLabel: string;

            if (currentValue === undefined || currentValue === null) {
              displayValue = 'none';
              scopeLabel = '';
            } else {
              if (def.type === 'boolean') {
                displayValue = currentValue ? 'on' : 'off';
              } else if (def.type === 'select' && def.options) {
                const option = def.options.find(o => o.value === currentValue);
                displayValue = option?.label || 'none';
              } else {
                displayValue = String(currentValue) || 'none';
              }

              const directSaveScope = getDirectSaveScope(def);
              if (def.key === SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY) {
                scopeLabel = '';
              } else if (directSaveScope) {
                scopeLabel = ` - ${directSaveScope}`;
              } else if (def.key === 'minPaneWidth' || def.key === 'maxPaneWidth') {
                scopeLabel = ' - global';
              } else {
                scopeLabel = isProjectOverride ? ' - project' : (isGlobalSetting ? ' - global' : '');
              }
            }

            return (
              <Box key={def.key}>
                <Text color={isSelected ? POPUP_CONFIG.titleColor : 'white'} bold={isSelected}>
                  {isSelected ? '▶ ' : '  '}
                  {def.label}
                </Text>
                <Text color={isSelected ? POPUP_CONFIG.titleColor : 'gray'} dimColor={!isSelected}>
                  {' '}({displayValue}{scopeLabel})
                </Text>
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>↑↓ to navigate • Enter to select • ESC to close</Text>
          </Box>
        </>
      )}

      {mode === 'edit' && currentDef && (
        <>
          <Box marginBottom={1}>
            <Text bold>{currentDef.label}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>{currentDef.description}</Text>
          </Box>

          {currentDef.type === 'boolean' && (
            <>
              <Box>
                <Text color={editingValueIndex === 0 ? POPUP_CONFIG.titleColor : 'white'} bold={editingValueIndex === 0}>
                  {editingValueIndex === 0 ? '▶ ' : '  '}Enable
                </Text>
              </Box>
              <Box>
                <Text color={editingValueIndex === 1 ? POPUP_CONFIG.titleColor : 'white'} bold={editingValueIndex === 1}>
                  {editingValueIndex === 1 ? '▶ ' : '  '}Disable
                </Text>
              </Box>
            </>
          )}

          {currentDef.type === 'select' && currentDef.options && (
            <>
              {currentDef.options.map((option, index) => (
                <Box key={option.value}>
                  <Text
                    color={getOptionColor(currentDef, option.value, editingValueIndex === index)}
                    bold={editingValueIndex === index}
                  >
                    {editingValueIndex === index ? '▶ ' : '  '}{option.label}
                  </Text>
                </Box>
              ))}
            </>
          )}

          {currentDef.type === 'text' && (
            <Box>
              <Text>{'> '}</Text>
              <TextInput
                value={textValue}
                onChange={setTextValue}
                onSubmit={() => { setMode('scope'); setScopeIndex(0); }}
                placeholder="Leave empty for default"
              />
            </Box>
          )}

          {currentDef.type === 'number' && (
            <Box>
              <Text color={POPUP_CONFIG.titleColor} bold>{numberValue}</Text>
              <Text dimColor> chars</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>
              {
                currentDef.type === 'text'
                  ? 'Type value • Enter scope • ESC back'
                  : currentDef.type === 'number'
                    ? '←→ adjust • Shift+←→ ±10 • Enter apply • ESC back'
                    : getDirectSaveScope(currentDef)
                      ? '↑↓ choose • Enter apply • ESC back'
                      : '↑↓ choose • Enter scope • ESC back'
              }
            </Text>
          </Box>
        </>
      )}

      {mode === 'scope' && currentDef && (
        <>
          <Box marginBottom={1}>
            <Text bold>Save {currentDef.label} as:</Text>
          </Box>

          <Box>
            <Text color={scopeIndex === 0 ? POPUP_CONFIG.titleColor : 'white'} bold={scopeIndex === 0}>
              {scopeIndex === 0 ? '▶ ' : '  '}Global (all projects)
            </Text>
          </Box>
          <Box>
            <Text color={scopeIndex === 1 ? POPUP_CONFIG.titleColor : 'white'} bold={scopeIndex === 1}>
              {scopeIndex === 1 ? '▶ ' : '  '}Project only
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>↑↓ to navigate • Enter to save • ESC to back</Text>
          </Box>
        </>
      )}
      </Box>
    </PopupWrapper>
  );
};

// Entry point
function main() {
  const resultFile = process.argv[2];
  const tempDataFile = process.argv[3];

  if (!resultFile || !tempDataFile) {
    console.error('Error: Result file and temp data file required');
    process.exit(1);
  }

  let data: {
    settingDefinitions: SettingDefinition[];
    settings: SettingsPopupValues;
    globalSettings: DmuxSettings;
    projectSettings: DmuxSettings;
    projectRoot: string;
    controlPaneId?: string;
    selectedIndex?: number;
  };

  try {
    data = JSON.parse(readFileSync(tempDataFile, 'utf-8'));
  } catch (error) {
    console.error('Error: Failed to read settings data file');
    process.exit(1);
  }

  render(
    <SettingsPopupApp
      resultFile={resultFile}
      settingDefinitions={data.settingDefinitions}
      settings={data.settings}
      globalSettings={data.globalSettings}
      projectSettings={data.projectSettings}
      projectRoot={data.projectRoot}
      controlPaneId={data.controlPaneId}
      selectedIndex={data.selectedIndex}
    />
  );
}

main();
