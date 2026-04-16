import { createHash } from 'crypto';
import path from 'path';
import type { DmuxPane } from '../types.js';
import { getPaneProjectName, getPaneProjectRoot } from './paneProject.js';

export const PANE_TITLE_DELIMITER = '__dmux__';
export const LEGACY_PANE_TITLE_DELIMITERS = ['::dmux::'] as const;
const ALL_PANE_TITLE_DELIMITERS = [PANE_TITLE_DELIMITER, ...LEGACY_PANE_TITLE_DELIMITERS];

// Tmux's s/foo/bar/: modifier uses ":" to separate the target variable, so the
// encoded title delimiter itself must not contain ":" or the format expands blank.
export const TMUX_PANE_TITLE_DISPLAY_FORMAT = `#{s|${PANE_TITLE_DELIMITER}.*$||:pane_title}`;

function getProjectTag(projectRoot: string, projectName: string): string {
  const hash = createHash('md5')
    .update(projectRoot)
    .digest('hex')
    .slice(0, 4);
  const sanitizedName = projectName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${sanitizedName}-${hash}`;
}

export function sanitizePaneDisplayName(value: string): string {
  return ALL_PANE_TITLE_DELIMITERS.reduce(
    (sanitized, delimiter) => sanitized.replaceAll(delimiter, ' '),
    value
  )
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getPaneDisplayName(
  pane: Pick<DmuxPane, 'slug' | 'displayName'>
): string {
  const displayName = typeof pane.displayName === 'string'
    ? sanitizePaneDisplayName(pane.displayName)
    : '';
  return displayName || pane.slug;
}

function encodePaneTmuxTitle(
  displayTitle: string,
  stableTitle: string,
  delimiter: string = PANE_TITLE_DELIMITER
): string {
  if (displayTitle === stableTitle) {
    return stableTitle;
  }
  return `${displayTitle}${delimiter}${stableTitle}`;
}

function getCustomPaneDisplayName(
  pane: Pick<DmuxPane, 'displayName'>
): string | undefined {
  if (typeof pane.displayName !== 'string') {
    return undefined;
  }

  const displayName = sanitizePaneDisplayName(pane.displayName);
  return displayName || undefined;
}

function getStablePaneTmuxTitle(
  pane: DmuxPane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  if (pane.type === 'shell') {
    return pane.slug;
  }

  const projectRoot = pane.projectRoot
    || (fallbackProjectRoot ? getPaneProjectRoot(pane, fallbackProjectRoot) : undefined);
  if (!projectRoot) {
    return pane.slug;
  }

  if (
    fallbackProjectRoot
    && path.resolve(projectRoot) === path.resolve(fallbackProjectRoot)
  ) {
    // Keep the original title style for panes in the session's primary project.
    return pane.slug;
  }

  const projectName = getPaneProjectName(pane, projectRoot, fallbackProjectName);
  return buildWorktreePaneTitle(pane.slug, projectRoot, projectName);
}

export function getPaneTmuxDisplayTitle(
  pane: DmuxPane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  return getCustomPaneDisplayName(pane)
    || getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
}

/**
 * Tmux pane title used for rebinding. Includes a stable project tag for
 * worktree panes so duplicate slugs across projects do not collide.
 */
export function getPaneTmuxTitle(
  pane: DmuxPane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  const stableTitle = getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
  const displayTitle = getPaneTmuxDisplayTitle(pane, fallbackProjectRoot, fallbackProjectName);

  return displayTitle
    ? encodePaneTmuxTitle(displayTitle, stableTitle)
    : stableTitle;
}

/**
 * Candidate titles to check when rebinding panes.
 * Includes legacy encoded titles so existing sessions keep rebinding after
 * delimiter migrations.
 */
export function getPaneTitleCandidates(
  pane: DmuxPane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string[] {
  const stableTitle = getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
  const displayTitle = getCustomPaneDisplayName(pane);
  const candidates = new Set<string>([stableTitle, pane.slug]);

  if (!displayTitle) {
    return Array.from(candidates);
  }

  for (const delimiter of ALL_PANE_TITLE_DELIMITERS) {
    candidates.add(encodePaneTmuxTitle(displayTitle, stableTitle, delimiter));
  }

  return Array.from(candidates);
}

export function buildWorktreePaneTitle(
  slug: string,
  projectRoot: string,
  projectName?: string
): string {
  const name = projectName || 'project';
  return `${slug}@${getProjectTag(projectRoot, name)}`;
}
