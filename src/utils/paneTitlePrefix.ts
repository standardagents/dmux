import type { DmuxPane, SidebarProject } from '../types.js';
import { getDmuxThemeAccent } from '../theme/colors.js';
import { getPaneColorTheme } from './paneColors.js';

export const PANE_TITLE_BUSY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const PANE_TITLE_IDLE_MARKER = '⠿';
export const TMUX_PANE_TITLE_PREFIX_FORMAT = '#{?@dmux_title_prefix,#{@dmux_title_prefix} ,}';
export const TMUX_PANE_TITLE_LABEL_FORMAT = '#{?@dmux_title_label,#{@dmux_title_label},#{s|__dmux__.*$||:pane_title}}';

function isBusyPane(pane: DmuxPane): boolean {
  return pane.agentStatus === 'working';
}

export function getPaneTitlePrefixValue(
  pane: DmuxPane,
  sidebarProjects: SidebarProject[],
  fallbackProjectRoot: string,
  spinnerFrameIndex: number = 0
): string {
  const themeName = getPaneColorTheme(pane, sidebarProjects, fallbackProjectRoot);
  const marker = isBusyPane(pane)
    ? PANE_TITLE_BUSY_FRAMES[spinnerFrameIndex % PANE_TITLE_BUSY_FRAMES.length]
    : PANE_TITLE_IDLE_MARKER;
  return `#[fg=${getDmuxThemeAccent(themeName)}]${marker}#[default]`;
}

export function paneNeedsAnimatedTitlePrefix(pane: DmuxPane): boolean {
  return isBusyPane(pane);
}
