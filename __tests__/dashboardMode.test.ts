import { describe, expect, it } from 'vitest';
import { computeDashboardTransition, computeAttentionPanes, getNextAttentionPane, computeProjectToggle } from '../src/hooks/useDashboardMode.js';
import type { DmuxPane } from '../src/types.js';

function mockPane(overrides: Partial<DmuxPane> = {}): DmuxPane {
  return { id: 'p1', slug: 'test', prompt: '', paneId: '%1', agentStatus: 'working', ...overrides };
}

describe('computeDashboardTransition', () => {
  it('minimizes working panes on enter', () => {
    const panes = [
      mockPane({ id: 'p1', agentStatus: 'working' }),
      mockPane({ id: 'p2', agentStatus: 'idle' }),
    ];
    const result = computeDashboardTransition(panes, true);
    expect(result.find(p => p.id === 'p1')!.minimized).toBe(true);
    expect(result.find(p => p.id === 'p2')!.minimized).toBe(false);
  });

  it('restores minimized panes on exit', () => {
    const panes = [
      mockPane({ id: 'p1', minimized: true }),
      mockPane({ id: 'p2', hidden: true }),
    ];
    const result = computeDashboardTransition(panes, false);
    expect(result.find(p => p.id === 'p1')!.minimized).toBe(false);
    expect(result.find(p => p.id === 'p2')!.hidden).toBe(true);
  });

  it('does not minimize already-hidden panes', () => {
    const panes = [mockPane({ id: 'p1', agentStatus: 'working', hidden: true })];
    const result = computeDashboardTransition(panes, true);
    expect(result[0].minimized).toBe(false);
  });
});

describe('computeAttentionPanes', () => {
  it('returns idle and waiting panes', () => {
    const panes = [
      mockPane({ id: 'p1', agentStatus: 'working' }),
      mockPane({ id: 'p2', agentStatus: 'idle' }),
      mockPane({ id: 'p3', agentStatus: 'waiting' }),
    ];
    expect(computeAttentionPanes(panes).map(p => p.id)).toEqual(['p2', 'p3']);
  });

  it('excludes hidden panes', () => {
    const panes = [mockPane({ id: 'p1', agentStatus: 'idle', hidden: true })];
    expect(computeAttentionPanes(panes)).toEqual([]);
  });
});

describe('getNextAttentionPane', () => {
  it('cycles through flagged panes', () => {
    const panes = [
      mockPane({ id: 'p1', needsAttention: true }),
      mockPane({ id: 'p2', needsAttention: true }),
      mockPane({ id: 'p3' }),
    ];
    expect(getNextAttentionPane(panes, undefined)!.id).toBe('p1');
    expect(getNextAttentionPane(panes, 'p1')!.id).toBe('p2');
    expect(getNextAttentionPane(panes, 'p2')!.id).toBe('p1');
  });

  it('returns null when none flagged', () => {
    expect(getNextAttentionPane([mockPane()], undefined)).toBeNull();
  });
});

describe('computeProjectToggle', () => {
  it('minimizes expanded project panes', () => {
    const panes = [
      mockPane({ id: 'p1', projectRoot: '/a' }),
      mockPane({ id: 'p2', projectRoot: '/b' }),
    ];
    const projects = [{ projectRoot: '/a', projectName: 'A' }];
    const result = computeProjectToggle(panes, 1, projects);
    expect(result.find(p => p.id === 'p1')!.minimized).toBe(true);
    expect(result.find(p => p.id === 'p2')!.minimized).toBeUndefined();
  });

  it('restores minimized project panes', () => {
    const panes = [
      mockPane({ id: 'p1', projectRoot: '/a', minimized: true }),
    ];
    const projects = [{ projectRoot: '/a', projectName: 'A' }];
    const result = computeProjectToggle(panes, 1, projects);
    expect(result.find(p => p.id === 'p1')!.minimized).toBe(false);
  });
});
