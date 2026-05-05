import { useState, useCallback, useRef } from 'react';
import type { DmuxPane, SidebarProject } from '../types.js';
import { WheelLayoutManager } from '../layout/WheelLayoutManager.js';
import { DEFAULT_DASHBOARD_ROWS, DEFAULT_DASHBOARD_COLUMNS } from '../constants/layout.js';

export function computeDashboardTransition(panes: DmuxPane[], entering: boolean): DmuxPane[] {
  if (entering) {
    return panes.map(pane => {
      if (pane.agentStatus === 'working' && !pane.hidden) {
        return { ...pane, minimized: true };
      }
      return { ...pane, minimized: false };
    });
  }
  return panes.map(pane => pane.minimized ? { ...pane, minimized: false } : pane);
}

export function computeAttentionPanes(panes: DmuxPane[]): DmuxPane[] {
  return panes.filter(p => !p.hidden && (p.agentStatus === 'idle' || p.agentStatus === 'waiting'));
}

export function getNextAttentionPane(panes: DmuxPane[], currentPaneId: string | undefined): DmuxPane | null {
  const flagged = panes.filter(p => p.needsAttention && !p.hidden);
  if (flagged.length === 0) return null;
  if (!currentPaneId) return flagged[0];
  const idx = flagged.findIndex(p => p.id === currentPaneId);
  return flagged[(idx + 1) % flagged.length];
}

export function computeProjectToggle(
  panes: DmuxPane[],
  projectIndex: number,
  sidebarProjects: SidebarProject[]
): DmuxPane[] {
  if (projectIndex < 1 || projectIndex > sidebarProjects.length) return panes;
  const target = sidebarProjects[projectIndex - 1];
  const projectPanes = panes.filter(p => p.projectRoot === target.projectRoot);
  const anyExpanded = projectPanes.some(p => !p.minimized && !p.hidden);

  return panes.map(pane => {
    if (pane.projectRoot !== target.projectRoot || pane.hidden) return pane;
    return { ...pane, minimized: anyExpanded };
  });
}

export function useDashboardMode(config?: { rows?: number; columns?: number }) {
  const rows = config?.rows ?? DEFAULT_DASHBOARD_ROWS;
  const columns = config?.columns ?? DEFAULT_DASHBOARD_COLUMNS;
  const [active, setActive] = useState(false);
  const wheelRef = useRef<WheelLayoutManager | null>(null);

  const toggle = useCallback((panes: DmuxPane[]): DmuxPane[] => {
    const entering = !active;
    setActive(entering);
    if (entering) {
      wheelRef.current = new WheelLayoutManager({ rows, columns });
      const result = computeDashboardTransition(panes, true);
      for (const pane of computeAttentionPanes(result)) {
        wheelRef.current.addPane(pane.paneId);
      }
      return result;
    }
    wheelRef.current?.reset();
    wheelRef.current = null;
    return computeDashboardTransition(panes, false);
  }, [active, rows, columns]);

  const expandPane = useCallback((paneId: string): number => {
    return wheelRef.current?.addPane(paneId) ?? -1;
  }, []);

  const minimizePane = useCallback((paneId: string): void => {
    wheelRef.current?.removePane(paneId);
  }, []);

  return { active, wheel: wheelRef.current, toggle, expandPane, minimizePane };
}
