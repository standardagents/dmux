import { describe, expect, it } from 'vitest';
import type { DmuxPane } from '../src/types.js';
import {
  getBulkVisibilityAction,
  getProjectVisibilityAction,
  getVisiblePanes,
  partitionPanesByProject,
  syncHiddenStateFromCurrentWindow,
} from '../src/utils/paneVisibility.js';

function pane(id: string, hidden = false, projectRoot = '/repo-a'): DmuxPane {
  return {
    id,
    slug: `pane-${id}`,
    prompt: `prompt-${id}`,
    paneId: `%${id.replace('dmux-', '')}`,
    hidden,
    projectRoot,
  };
}

describe('paneVisibility', () => {
  it('excludes minimized panes from visible panes', () => {
    const panes = [
      pane('dmux-1', false),
      { ...pane('dmux-2', false), minimized: true },
      pane('dmux-3', false),
    ];

    const visible = getVisiblePanes(panes);
    expect(visible.map(p => p.id)).toEqual(['dmux-1', 'dmux-3']);
  });

  it('syncs hidden flags from the active window pane list', () => {
    const panes = [
      pane('dmux-1', true),
      pane('dmux-2', false),
      pane('dmux-3', false),
    ];

    const synced = syncHiddenStateFromCurrentWindow(panes, ['%2']);

    expect(synced.map((entry) => entry.hidden)).toEqual([true, false, true]);
  });

  it('preserves hidden flags when no current window pane list is available', () => {
    const panes = [
      pane('dmux-1', true),
      pane('dmux-2', false),
    ];

    const synced = syncHiddenStateFromCurrentWindow(panes, []);

    expect(synced).toEqual(panes);
  });

  it('chooses hide-others when any other pane is visible', () => {
    const panes = [
      pane('dmux-1', false),
      pane('dmux-2', false),
      pane('dmux-3', true),
    ];

    expect(getBulkVisibilityAction(panes, panes[0])).toBe('hide-others');
  });

  it('chooses show-others when all other panes are hidden', () => {
    const panes = [
      pane('dmux-1', false),
      pane('dmux-2', true),
      pane('dmux-3', true),
    ];

    expect(getBulkVisibilityAction(panes, panes[0])).toBe('show-others');
  });

  it('returns only visible panes', () => {
    const panes = [
      pane('dmux-1', false),
      pane('dmux-2', true),
      pane('dmux-3', false),
    ];

    expect(getVisiblePanes(panes).map((entry) => entry.id)).toEqual([
      'dmux-1',
      'dmux-3',
    ]);
  });

  it('partitions panes by project root', () => {
    const panes = [
      pane('dmux-1', false, '/repo-a'),
      pane('dmux-2', true, '/repo-a'),
      pane('dmux-3', false, '/repo-b'),
    ];

    const { projectPanes, otherPanes } = partitionPanesByProject(
      panes,
      '/repo-a',
      '/fallback'
    );

    expect(projectPanes.map((entry) => entry.id)).toEqual(['dmux-1', 'dmux-2']);
    expect(otherPanes.map((entry) => entry.id)).toEqual(['dmux-3']);
  });

  it('chooses focus-project when other projects are still visible', () => {
    const panes = [
      pane('dmux-1', false, '/repo-a'),
      pane('dmux-2', false, '/repo-a'),
      pane('dmux-3', false, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('focus-project');
  });

  it('chooses focus-project when selected project has hidden panes', () => {
    const panes = [
      pane('dmux-1', false, '/repo-a'),
      pane('dmux-2', true, '/repo-a'),
      pane('dmux-3', true, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('focus-project');
  });

  it('chooses show-all when the selected project is already focused', () => {
    const panes = [
      pane('dmux-1', false, '/repo-a'),
      pane('dmux-2', false, '/repo-a'),
      pane('dmux-3', true, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('show-all');
  });
});
