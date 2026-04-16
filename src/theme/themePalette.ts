import type { DmuxThemeName } from '../types.js';

export const DMUX_THEME_NAMES = [
  'red',
  'blue',
  'yellow',
  'orange',
  'green',
  'purple',
  'cyan',
  'magenta',
] as const satisfies readonly DmuxThemeName[];

export const DEFAULT_DMUX_THEME: DmuxThemeName = 'orange';

export function isDmuxThemeName(value: unknown): value is DmuxThemeName {
  return typeof value === 'string' && (DMUX_THEME_NAMES as readonly string[]).includes(value);
}

export function normalizeDmuxTheme(value: unknown): DmuxThemeName {
  return isDmuxThemeName(value) ? value : DEFAULT_DMUX_THEME;
}
