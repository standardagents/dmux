import path from "path";
import type { DmuxPane } from "../types.js";
import { getPaneProjectRoot } from "./paneProject.js";

export type PaneBulkVisibilityAction = "hide-others" | "show-others";
export type PaneProjectVisibilityAction = "focus-project" | "show-all";

function sameProjectRoot(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function getVisiblePanes(panes: DmuxPane[]): DmuxPane[] {
  return panes.filter((pane) => !pane.hidden && !pane.minimized);
}

export function syncHiddenStateFromCurrentWindow(
  panes: DmuxPane[],
  currentWindowPaneIds: string[]
): DmuxPane[] {
  if (currentWindowPaneIds.length === 0) {
    return panes;
  }

  return panes.map((pane) => {
    const hidden = !currentWindowPaneIds.includes(pane.paneId);
    return pane.hidden === hidden ? pane : { ...pane, hidden };
  });
}

export function getBulkVisibilityAction(
  panes: DmuxPane[],
  selectedPane: DmuxPane
): PaneBulkVisibilityAction | null {
  const otherPanes = panes.filter((pane) => pane.id !== selectedPane.id);
  if (otherPanes.length === 0) {
    return null;
  }

  if (otherPanes.some((pane) => !pane.hidden)) {
    return "hide-others";
  }

  if (otherPanes.some((pane) => pane.hidden)) {
    return "show-others";
  }

  return null;
}

export function partitionPanesByProject(
  panes: DmuxPane[],
  targetProjectRoot: string,
  fallbackProjectRoot: string
): { projectPanes: DmuxPane[]; otherPanes: DmuxPane[] } {
  const projectPanes: DmuxPane[] = [];
  const otherPanes: DmuxPane[] = [];

  for (const pane of panes) {
    const paneProjectRoot = getPaneProjectRoot(pane, fallbackProjectRoot);
    if (sameProjectRoot(paneProjectRoot, targetProjectRoot)) {
      projectPanes.push(pane);
    } else {
      otherPanes.push(pane);
    }
  }

  return { projectPanes, otherPanes };
}

export function getProjectVisibilityAction(
  panes: DmuxPane[],
  targetProjectRoot: string,
  fallbackProjectRoot: string
): PaneProjectVisibilityAction | null {
  const { projectPanes, otherPanes } = partitionPanesByProject(
    panes,
    targetProjectRoot,
    fallbackProjectRoot
  );

  if (projectPanes.length === 0) {
    return null;
  }

  const hasHiddenProjectPanes = projectPanes.some((pane) => pane.hidden);
  const hasVisibleOtherPanes = otherPanes.some((pane) => !pane.hidden);
  if (hasHiddenProjectPanes || hasVisibleOtherPanes) {
    return "focus-project";
  }

  if (otherPanes.some((pane) => pane.hidden)) {
    return "show-all";
  }

  return null;
}
