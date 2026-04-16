import { SettingsManager } from '../utils/settingsManager.js';
import type { DmuxThemeName } from '../types.js';
import {
  DEFAULT_DMUX_THEME,
  isDmuxThemeName,
  normalizeDmuxTheme,
} from './themePalette.js';

interface ThemePalette {
  accentHex: string;
  activeBorder: string;
  artPrimary: string;
  artTail: string[];
}

const THEME_PALETTES: Record<DmuxThemeName, ThemePalette> = {
  red: {
    accentHex: '#ff5f5f',
    activeBorder: '203',
    artPrimary: '\x1b[38;5;203m',
    artTail: ['\x1b[38;5;210m', '\x1b[38;5;203m', '\x1b[38;5;196m', '\x1b[38;5;160m', '\x1b[38;5;124m', '\x1b[38;5;88m', '\x1b[38;5;52m', '\x1b[38;5;236m'],
  },
  blue: {
    accentHex: '#5f87ff',
    activeBorder: '75',
    artPrimary: '\x1b[38;5;75m',
    artTail: ['\x1b[38;5;117m', '\x1b[38;5;75m', '\x1b[38;5;69m', '\x1b[38;5;33m', '\x1b[38;5;27m', '\x1b[38;5;25m', '\x1b[38;5;18m', '\x1b[38;5;236m'],
  },
  yellow: {
    accentHex: '#ffd75f',
    activeBorder: '221',
    artPrimary: '\x1b[38;5;221m',
    artTail: ['\x1b[38;5;227m', '\x1b[38;5;221m', '\x1b[38;5;220m', '\x1b[38;5;214m', '\x1b[38;5;178m', '\x1b[38;5;142m', '\x1b[38;5;100m', '\x1b[38;5;236m'],
  },
  orange: {
    accentHex: '#ff8700',
    activeBorder: '214',
    artPrimary: '\x1b[38;5;208m',
    artTail: ['\x1b[38;5;214m', '\x1b[38;5;208m', '\x1b[38;5;202m', '\x1b[38;5;166m', '\x1b[38;5;130m', '\x1b[38;5;94m', '\x1b[38;5;58m', '\x1b[38;5;236m'],
  },
  green: {
    accentHex: '#5fd75f',
    activeBorder: '77',
    artPrimary: '\x1b[38;5;77m',
    artTail: ['\x1b[38;5;120m', '\x1b[38;5;77m', '\x1b[38;5;70m', '\x1b[38;5;40m', '\x1b[38;5;34m', '\x1b[38;5;28m', '\x1b[38;5;22m', '\x1b[38;5;236m'],
  },
  purple: {
    accentHex: '#af87ff',
    activeBorder: '141',
    artPrimary: '\x1b[38;5;141m',
    artTail: ['\x1b[38;5;183m', '\x1b[38;5;141m', '\x1b[38;5;135m', '\x1b[38;5;99m', '\x1b[38;5;93m', '\x1b[38;5;57m', '\x1b[38;5;55m', '\x1b[38;5;236m'],
  },
  cyan: {
    accentHex: '#5fd7d7',
    activeBorder: '80',
    artPrimary: '\x1b[38;5;80m',
    artTail: ['\x1b[38;5;123m', '\x1b[38;5;80m', '\x1b[38;5;44m', '\x1b[38;5;37m', '\x1b[38;5;31m', '\x1b[38;5;24m', '\x1b[38;5;23m', '\x1b[38;5;236m'],
  },
  magenta: {
    accentHex: '#ff5fd7',
    activeBorder: '206',
    artPrimary: '\x1b[38;5;206m',
    artTail: ['\x1b[38;5;213m', '\x1b[38;5;206m', '\x1b[38;5;199m', '\x1b[38;5;163m', '\x1b[38;5;127m', '\x1b[38;5;90m', '\x1b[38;5;53m', '\x1b[38;5;236m'],
  },
};

function assignMutableRecord<T extends Record<string, string>>(target: T, source: T): void {
  for (const [key, value] of Object.entries(source)) {
    target[key as keyof T] = value as T[keyof T];
  }
}

export const COLORS = {
  accent: '',
  selected: '',
  unselected: 'white',
  border: 'gray',
  borderSelected: '',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  working: 'cyan',
  analyzing: 'magenta',
  waiting: 'yellow',
} as const satisfies Record<string, string>;

export const TMUX_COLORS = {
  activeBorder: '',
  inactiveBorder: '240',
} as const satisfies Record<string, string>;

export const DECORATIVE_THEME = {
  primary: '',
  fill: '\x1b[38;5;238m',
  reset: '\x1b[0m',
  tail: Array.from({ length: 8 }, () => ''),
} as const;

let activeThemeName: DmuxThemeName = DEFAULT_DMUX_THEME;

export function applyDmuxTheme(themeName: DmuxThemeName): DmuxThemeName {
  const nextTheme = THEME_PALETTES[themeName];
  activeThemeName = themeName;

  assignMutableRecord(COLORS as unknown as Record<string, string>, {
    ...COLORS,
    accent: nextTheme.accentHex,
    selected: nextTheme.accentHex,
    borderSelected: nextTheme.accentHex,
  });

  assignMutableRecord(TMUX_COLORS as unknown as Record<string, string>, {
    ...TMUX_COLORS,
    activeBorder: nextTheme.activeBorder,
  });

  (DECORATIVE_THEME as { primary: string }).primary = nextTheme.artPrimary;
  (DECORATIVE_THEME as { tail: string[] }).tail = [...nextTheme.artTail];

  return activeThemeName;
}

export function getActiveDmuxTheme(): DmuxThemeName {
  return activeThemeName;
}

export function syncDmuxThemeFromSettings(projectRoot?: string): DmuxThemeName {
  try {
    const settings = new SettingsManager(projectRoot || process.cwd()).getSettings();
    return applyDmuxTheme(normalizeDmuxTheme(settings.colorTheme));
  } catch {
    return applyDmuxTheme(DEFAULT_DMUX_THEME);
  }
}

// Keep module consumers working without explicit setup.
if (process.env.DMUX_THEME && isDmuxThemeName(process.env.DMUX_THEME)) {
  applyDmuxTheme(process.env.DMUX_THEME);
} else {
  syncDmuxThemeFromSettings(process.cwd());
}
