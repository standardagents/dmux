# Dashboard Mode & Attention-Driven Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-toggled dashboard mode that collapses working agent panes into enhanced sidebar status lines and displays attention-needing panes in a stable wheel grid layout.

**Architecture:** Provider-abstracted LLM analysis with periodic task adherence checks feeds into a fixed-geometry wheel layout triggered by a `Ctrl+\` leader key prefix. Minimized panes show LLM-generated summaries with on-track evaluation in the sidebar.

**Tech Stack:** TypeScript, Ink (React for CLI), Vitest, tmux CLI, `@anthropic-ai/claude-code` SDK (optional)

---

## File Structure

### New files:
| File | Responsibility |
|------|---------------|
| `src/providers/AnalysisProvider.ts` | Provider interface, auto-detection factory, provider registry |
| `src/providers/OpenRouterProvider.ts` | OpenRouter API implementation (extracted from PaneAnalyzer) |
| `src/providers/ClaudeCodeProvider.ts` | Claude Code SDK implementation |
| `src/providers/HeuristicsOnlyProvider.ts` | No-op fallback (returns `in_progress`) |
| `src/layout/WheelLayoutManager.ts` | Fixed-geometry wheel layout calculator + slot queue |
| `src/hooks/useLeaderKey.ts` | `Ctrl+\` leader key state machine with timeout |
| `src/hooks/useDashboardMode.ts` | Dashboard state, toggle, minimize/restore logic |
| `__tests__/providers/analysisProvider.test.ts` | Provider interface + auto-detection tests |
| `__tests__/providers/openRouterProvider.test.ts` | OpenRouter provider tests |
| `__tests__/wheelLayout.test.ts` | Wheel layout geometry + slot queue tests |
| `__tests__/leaderKey.test.ts` | Leader key state machine tests |
| `__tests__/dashboardMode.test.ts` | Dashboard toggle + minimize/restore tests |
| `__tests__/adherenceCheck.test.ts` | Task adherence analysis tests |

### Modified files:
| File | Changes |
|------|---------|
| `src/types.ts` | Add `minimized`, `taskContext` to `DmuxPane`; add dashboard settings to `DmuxSettings` |
| `src/constants/layout.ts` | Add dashboard defaults |
| `src/services/PaneAnalyzer.ts` | Use provider interface; add adherence to Stage 3 prompt |
| `src/services/StatusDetector.ts` | Add periodic adherence timer for working panes; emit task context updates |
| `src/components/panes/PaneCard.tsx` | Render summary line for minimized panes |
| `src/hooks/useInputHandling.ts` | Integrate leader key hook; dispatch dashboard actions |
| `src/hooks/useLayoutManagement.ts` | Route to wheel layout when dashboard active |
| `src/utils/layoutManager.ts` | Integrate WheelLayoutManager |
| `src/utils/paneVisibility.ts` | Exclude minimized panes from grid |
| `src/utils/settingsManager.ts` | Add dashboard settings validation |
| `src/services/DmuxFocusService.ts` | Amber/red border management for wheel slots |
## Task 1: Type Extensions

**Files:**
- Modify: `src/types.ts:42-82`
- Modify: `src/types.ts:104-139`
- Modify: `src/constants/layout.ts`

- [ ] **Step 1: Add `minimized` and `taskContext` to DmuxPane**

In `src/types.ts`, add after `hidden` (line 49):

```typescript
  minimized?: boolean; // Pane is collapsed by dashboard mode (distinct from hidden)
  taskContext?: string; // Latest intended task — stored prompt or last meaningful user input
```

- [ ] **Step 2: Add dashboard settings to DmuxSettings**

In `src/types.ts`, add before closing `}` of `DmuxSettings`:

```typescript
  // Dashboard mode settings
  dashboardRows?: number;
  dashboardColumns?: number;
  analysisBackend?: 'auto' | 'claude-code' | 'openrouter' | 'heuristics';
  adherenceCheckInterval?: number; // seconds
```

- [ ] **Step 3: Add dashboard constants**

In `src/constants/layout.ts`, append:

```typescript
// Dashboard mode defaults
export const DEFAULT_DASHBOARD_ROWS = 2;
export const DEFAULT_DASHBOARD_COLUMNS = 4;
export const DEFAULT_ADHERENCE_CHECK_INTERVAL = 45; // seconds
export const LEADER_KEY_TIMEOUT = 500; // ms
export const LEADER_KEY_CODE = '\x1c'; // Ctrl+\ = ASCII 28 (FS)
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/constants/layout.ts
git commit -m "feat(dashboard): add type extensions for minimized state and settings"
```

---

## Task 2: Analysis Provider Interface

**Files:**
- Create: `src/providers/AnalysisProvider.ts`
- Create: `src/providers/OpenRouterProvider.ts`
- Create: `src/providers/HeuristicsOnlyProvider.ts`
- Create: `__tests__/providers/analysisProvider.test.ts`
- Create: `__tests__/providers/openRouterProvider.test.ts`

- [ ] **Step 1: Write failing tests for provider factory**

Create `__tests__/providers/analysisProvider.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createAnalysisProvider } from '../../src/providers/AnalysisProvider.js';

describe('createAnalysisProvider', () => {
  it('returns heuristics provider when backend is "heuristics"', () => {
    const provider = createAnalysisProvider('heuristics');
    expect(provider.isAvailable()).toBe(true);
    expect(provider.name).toBe('heuristics');
  });

  it('returns openrouter provider when key exists', () => {
    const provider = createAnalysisProvider('openrouter', { openRouterKey: 'sk-test' });
    expect(provider.isAvailable()).toBe(true);
    expect(provider.name).toBe('openrouter');
  });

  it('openrouter reports unavailable without key', () => {
    const provider = createAnalysisProvider('openrouter', { openRouterKey: '' });
    expect(provider.isAvailable()).toBe(false);
  });

  it('auto uses openrouter if key available', () => {
    const provider = createAnalysisProvider('auto', { openRouterKey: 'sk-test' });
    expect(provider.isAvailable()).toBe(true);
  });

  it('auto falls back to heuristics', () => {
    const provider = createAnalysisProvider('auto', { openRouterKey: '' });
    expect(provider.name).toBe('heuristics');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- __tests__/providers/analysisProvider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/providers/AnalysisProvider.ts`**

```typescript
export interface AnalysisPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

export interface AnalysisProvider {
  analyze(prompt: AnalysisPrompt, signal?: AbortSignal): Promise<string>;
  isAvailable(): boolean;
  readonly name: string;
}

export interface ProviderOptions {
  openRouterKey?: string;
  claudeCodeAvailable?: boolean;
}

export function createAnalysisProvider(
  backend: 'auto' | 'claude-code' | 'openrouter' | 'heuristics',
  options: ProviderOptions = {}
): AnalysisProvider {
  const { openRouterKey = process.env.OPENROUTER_API_KEY || '' } = options;

  switch (backend) {
    case 'openrouter': {
      const { OpenRouterProvider } = require('./OpenRouterProvider.js');
      return new OpenRouterProvider(openRouterKey);
    }
    case 'claude-code': {
      const { ClaudeCodeProvider } = require('./ClaudeCodeProvider.js');
      return new ClaudeCodeProvider();
    }
    case 'heuristics': {
      const { HeuristicsOnlyProvider } = require('./HeuristicsOnlyProvider.js');
      return new HeuristicsOnlyProvider();
    }
    case 'auto':
    default: {
      if (options.claudeCodeAvailable) {
        try {
          const { ClaudeCodeProvider } = require('./ClaudeCodeProvider.js');
          const p = new ClaudeCodeProvider();
          if (p.isAvailable()) return p;
        } catch { /* not installed */ }
      }
      if (openRouterKey) {
        const { OpenRouterProvider } = require('./OpenRouterProvider.js');
        const p = new OpenRouterProvider(openRouterKey);
        if (p.isAvailable()) return p;
      }
      const { HeuristicsOnlyProvider } = require('./HeuristicsOnlyProvider.js');
      return new HeuristicsOnlyProvider();
    }
  }
}
```

- [ ] **Step 4: Create `src/providers/HeuristicsOnlyProvider.ts`**

```typescript
import type { AnalysisProvider, AnalysisPrompt } from './AnalysisProvider.js';

export class HeuristicsOnlyProvider implements AnalysisProvider {
  readonly name = 'heuristics';

  async analyze(_prompt: AnalysisPrompt, _signal?: AbortSignal): Promise<string> {
    return JSON.stringify({ state: 'in_progress' });
  }

  isAvailable(): boolean {
    return true;
  }
}
```

- [ ] **Step 5: Create `src/providers/OpenRouterProvider.ts`**

```typescript
import type { AnalysisProvider, AnalysisPrompt } from './AnalysisProvider.js';
import { LogService } from '../services/LogService.js';

export class OpenRouterProvider implements AnalysisProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private modelStack = [
    'google/gemini-2.5-flash',
    'x-ai/grok-4-fast:free',
    'openai/gpt-4o-mini',
  ];

  constructor(apiKey: string) { this.apiKey = apiKey; }

  isAvailable(): boolean { return this.apiKey.length > 0; }

  async analyze(prompt: AnalysisPrompt, signal?: AbortSignal): Promise<string> {
    if (!this.apiKey) throw new Error('OpenRouter API key not available');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      return await Promise.any(
        this.modelStack.map(model => this.tryModel(model, prompt, combinedSignal))
      );
    } catch (error) {
      if (error instanceof AggregateError) {
        throw error.errors[0] || new Error('All models failed');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async tryModel(model: string, prompt: AnalysisPrompt, signal: AbortSignal): Promise<string> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/dmux/dmux',
        'X-Title': 'dmux',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.1,
        max_tokens: prompt.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`API error (${model}): ${response.status}`);
    }
    const data = await response.json() as any;
    LogService.getInstance().debug(`OpenRouterProvider: ${model} succeeded`, 'paneAnalyzer');
    return data.choices?.[0]?.message?.content || '';
  }
}
```

- [ ] **Step 6: Write OpenRouterProvider tests**

Create `__tests__/providers/openRouterProvider.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../../src/providers/OpenRouterProvider.js';

describe('OpenRouterProvider', () => {
  it('reports unavailable without key', () => {
    expect(new OpenRouterProvider('').isAvailable()).toBe(false);
  });

  it('reports available with key', () => {
    expect(new OpenRouterProvider('sk-test').isAvailable()).toBe(true);
  });

  it('throws analyzing without key', async () => {
    await expect(
      new OpenRouterProvider('').analyze({ system: 'x', user: 'x', maxTokens: 10 })
    ).rejects.toThrow('API key not available');
  });

  it('respects abort signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      new OpenRouterProvider('sk-test').analyze({ system: 'x', user: 'x', maxTokens: 10 }, ctrl.signal)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm run test -- __tests__/providers/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/providers/ __tests__/providers/
git commit -m "feat(dashboard): add analysis provider interface with OpenRouter and heuristics"
```
## Task 3: Leader Key Hook

**Files:**
- Create: `src/hooks/useLeaderKey.ts`
- Create: `__tests__/leaderKey.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/leaderKey.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LeaderKeyStateMachine } from '../src/hooks/useLeaderKey.js';
import { LEADER_KEY_CODE, LEADER_KEY_TIMEOUT } from '../src/constants/layout.js';

describe('LeaderKeyStateMachine', () => {
  let machine: LeaderKeyStateMachine;
  let onAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onAction = vi.fn();
    machine = new LeaderKeyStateMachine(onAction);
  });

  afterEach(() => {
    vi.useRealTimers();
    machine.destroy();
  });

  it('starts idle', () => {
    expect(machine.state).toBe('idle');
  });

  it('transitions to pending on leader key', () => {
    expect(machine.handleInput(LEADER_KEY_CODE)).toBe(true);
    expect(machine.state).toBe('pending');
  });

  it('dispatches action on follow-up key', () => {
    machine.handleInput(LEADER_KEY_CODE);
    machine.handleInput('m');
    expect(onAction).toHaveBeenCalledWith('m');
    expect(machine.state).toBe('idle');
  });

  it('resets after timeout', () => {
    machine.handleInput(LEADER_KEY_CODE);
    vi.advanceTimersByTime(LEADER_KEY_TIMEOUT + 1);
    expect(machine.state).toBe('idle');
  });

  it('does not dispatch after timeout', () => {
    machine.handleInput(LEADER_KEY_CODE);
    vi.advanceTimersByTime(LEADER_KEY_TIMEOUT + 1);
    machine.handleInput('m');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('ignores non-leader keys in idle', () => {
    expect(machine.handleInput('x')).toBe(false);
  });

  it('dispatches number keys', () => {
    machine.handleInput(LEADER_KEY_CODE);
    machine.handleInput('3');
    expect(onAction).toHaveBeenCalledWith('3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- __tests__/leaderKey.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement LeaderKeyStateMachine**

Create `src/hooks/useLeaderKey.ts`:

```typescript
import { useRef, useCallback } from 'react';
import { LEADER_KEY_CODE, LEADER_KEY_TIMEOUT } from '../constants/layout.js';

export type LeaderKeyState = 'idle' | 'pending';

export class LeaderKeyStateMachine {
  state: LeaderKeyState = 'idle';
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private onAction: (key: string) => void;

  constructor(onAction: (key: string) => void) {
    this.onAction = onAction;
  }

  handleInput(input: string): boolean {
    if (this.state === 'idle') {
      if (input === LEADER_KEY_CODE) {
        this.state = 'pending';
        this.timeoutId = setTimeout(() => { this.state = 'idle'; }, LEADER_KEY_TIMEOUT);
        return true;
      }
      return false;
    }

    // state === 'pending'
    this.clearTimeout();
    this.state = 'idle';
    this.onAction(input);
    return true;
  }

  private clearTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  destroy(): void {
    this.clearTimeout();
  }
}

export function useLeaderKey(onAction: (key: string) => void) {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  const machineRef = useRef<LeaderKeyStateMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = new LeaderKeyStateMachine((key) => onActionRef.current(key));
  }

  const handleInput = useCallback((input: string): boolean => {
    return machineRef.current!.handleInput(input);
  }, []);

  return { handleInput, state: machineRef.current.state };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm run test -- __tests__/leaderKey.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLeaderKey.ts __tests__/leaderKey.test.ts
git commit -m "feat(dashboard): add leader key state machine (Ctrl+\\\\)"
```

---

## Task 4: Wheel Layout Manager

**Files:**
- Create: `src/layout/WheelLayoutManager.ts`
- Create: `__tests__/wheelLayout.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/wheelLayout.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { WheelLayoutManager } from '../src/layout/WheelLayoutManager.js';

describe('WheelLayoutManager', () => {
  describe('slot allocation', () => {
    it('assigns first pane to slot 0', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      expect(wheel.addPane('p1')).toBe(0);
    });

    it('fills row-major order', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      const slots = ['p1','p2','p3','p4','p5'].map(id => wheel.addPane(id));
      expect(slots).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns -1 when full', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2');
      expect(wheel.addPane('p3')).toBe(-1);
    });

    it('reports capacity', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      expect(wheel.capacity).toBe(8);
    });
  });

  describe('removal and shifting', () => {
    it('shifts subsequent panes down', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2'); wheel.addPane('p3');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p2');
      expect(wheel.getPaneAtSlot(1)).toBe('p3');
      expect(wheel.getPaneAtSlot(2)).toBeNull();
    });

    it('tracks filled count', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2');
      expect(wheel.filledSlots).toBe(2);
      wheel.removePane('p1');
      expect(wheel.filledSlots).toBe(1);
    });
  });

  describe('overflow queue', () => {
    it('queues overflow FIFO', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2');
      wheel.addPane('p3'); wheel.addPane('p4');
      expect(wheel.overflowQueue).toEqual(['p3', 'p4']);
    });

    it('auto-fills from overflow on removal', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2'); wheel.addPane('p3');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p2');
      expect(wheel.getPaneAtSlot(1)).toBe('p3');
      expect(wheel.overflowQueue).toEqual([]);
    });
  });

  describe('geometry', () => {
    it('calculates pane dimensions', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      const geo = wheel.calculateGeometry(200, 40, 40);
      expect(geo.paneWidth).toBeGreaterThan(30);
      expect(geo.paneHeight).toBeGreaterThan(10);
      expect(geo.columns).toBe(4);
      expect(geo.rows).toBe(2);
    });
  });

  describe('split pane exclusion', () => {
    it('split panes cannot be removed', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2');
      wheel.markAsSplit('p1');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p1');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- __tests__/wheelLayout.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement WheelLayoutManager**

Create `src/layout/WheelLayoutManager.ts`:

```typescript
export interface WheelConfig {
  rows: number;
  columns: number;
}

export interface WheelGeometry {
  paneWidth: number;
  paneHeight: number;
  columns: number;
  rows: number;
}

export class WheelLayoutManager {
  private config: WheelConfig;
  private slots: (string | null)[];
  private _overflowQueue: string[] = [];
  private splitPanes = new Set<string>();

  constructor(config: WheelConfig) {
    this.config = config;
    this.slots = new Array(config.rows * config.columns).fill(null);
  }

  get capacity(): number { return this.config.rows * this.config.columns; }

  get filledSlots(): number { return this.slots.filter(s => s !== null).length; }

  get overflowQueue(): string[] { return [...this._overflowQueue]; }

  addPane(paneId: string): number {
    const slot = this.slots.indexOf(null);
    if (slot === -1) {
      this._overflowQueue.push(paneId);
      return -1;
    }
    this.slots[slot] = paneId;
    return slot;
  }

  removePane(paneId: string): void {
    if (this.splitPanes.has(paneId)) return;

    const index = this.slots.indexOf(paneId);
    if (index === -1) {
      this._overflowQueue = this._overflowQueue.filter(id => id !== paneId);
      return;
    }

    this.slots.splice(index, 1);
    this.slots.push(null);

    if (this._overflowQueue.length > 0) {
      const next = this._overflowQueue.shift()!;
      const empty = this.slots.indexOf(null);
      if (empty !== -1) this.slots[empty] = next;
    }
  }

  getPaneAtSlot(slot: number): string | null { return this.slots[slot] ?? null; }

  getSlotForPane(paneId: string): number { return this.slots.indexOf(paneId); }

  getAllPaneIds(): string[] { return this.slots.filter((s): s is string => s !== null); }

  markAsSplit(paneId: string): void { this.splitPanes.add(paneId); }

  isSplit(paneId: string): boolean { return this.splitPanes.has(paneId); }

  calculateGeometry(terminalWidth: number, terminalHeight: number, sidebarWidth: number): WheelGeometry {
    const contentWidth = terminalWidth - sidebarWidth - 1;
    const paneWidth = Math.floor((contentWidth - (this.config.columns - 1)) / this.config.columns);
    const paneHeight = Math.floor((terminalHeight - (this.config.rows - 1)) / this.config.rows);
    return { paneWidth, paneHeight, columns: this.config.columns, rows: this.config.rows };
  }

  reset(): void {
    this.slots.fill(null);
    this._overflowQueue = [];
    this.splitPanes.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm run test -- __tests__/wheelLayout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/layout/WheelLayoutManager.ts __tests__/wheelLayout.test.ts
git commit -m "feat(dashboard): add wheel layout manager with slot queue and overflow"
```

---

## Task 5: Dashboard Mode Hook

**Files:**
- Create: `src/hooks/useDashboardMode.ts`
- Create: `__tests__/dashboardMode.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/dashboardMode.test.ts`:

```typescript
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
    expect(result.find(p => p.id === 'p2')!.hidden).toBe(true); // untouched
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- __tests__/dashboardMode.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dashboard mode logic**

Create `src/hooks/useDashboardMode.ts`:

```typescript
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
      return pane;
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm run test -- __tests__/dashboardMode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDashboardMode.ts __tests__/dashboardMode.test.ts
git commit -m "feat(dashboard): add dashboard mode hook with transition and project toggle"
```
## Task 6: Pane Visibility — Exclude Minimized

**Files:**
- Modify: `src/utils/paneVisibility.ts`
- Modify: `__tests__/paneVisibility.test.ts`

- [ ] **Step 1: Write failing test**

Add to `__tests__/paneVisibility.test.ts` inside the `paneVisibility` describe block:

```typescript
  it('excludes minimized panes from visible panes', () => {
    const panes = [
      pane('dmux-1', false),
      { ...pane('dmux-2', false), minimized: true },
      pane('dmux-3', false),
    ];
    const visible = getVisiblePanes(panes);
    expect(visible.map(p => p.id)).toEqual(['dmux-1', 'dmux-3']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- __tests__/paneVisibility.test.ts`
Expected: FAIL — minimized pane still included

- [ ] **Step 3: Update getVisiblePanes**

In `src/utils/paneVisibility.ts`, change:

```typescript
export function getVisiblePanes(panes: DmuxPane[]): DmuxPane[] {
  return panes.filter(p => !p.hidden && !p.minimized);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm run test -- __tests__/paneVisibility.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/paneVisibility.ts __tests__/paneVisibility.test.ts
git commit -m "feat(dashboard): exclude minimized panes from visible pane calculation"
```

---

## Task 7: PaneCard Summary Line

**Files:**
- Modify: `src/components/panes/PaneCard.tsx`

- [ ] **Step 1: Read PaneCard to understand structure**

Read `src/components/panes/PaneCard.tsx` — note the `ROW_WIDTH` constant and the memo equality check.

- [ ] **Step 2: Add summary line for minimized panes**

After the main row `<Box>`, add a conditional second line:

```tsx
{pane.minimized && pane.agentSummary && (
  <Box width={ROW_WIDTH}>
    <Text dimColor wrap="truncate">
      {'   '}{pane.agentSummary.slice(0, ROW_WIDTH - 3)}
    </Text>
  </Box>
)}
```

- [ ] **Step 3: Update memo equality check**

Add to the existing equality comparison:

```typescript
prev.pane.minimized === next.pane.minimized &&
prev.pane.agentSummary === next.pane.agentSummary &&
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/panes/PaneCard.tsx
git commit -m "feat(dashboard): render summary line below minimized panes in sidebar"
```

---

## Task 8: Task Adherence in PaneAnalyzer

**Files:**
- Modify: `src/services/PaneAnalyzer.ts`
- Create: `__tests__/adherenceCheck.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/adherenceCheck.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildAdherencePrompt, parseAdherenceResponse } from '../src/services/PaneAnalyzer.js';

describe('buildAdherencePrompt', () => {
  it('includes task context', () => {
    const prompt = buildAdherencePrompt('output...', 'Implement JWT auth');
    expect(prompt).toContain('Implement JWT auth');
    expect(prompt).toContain('output...');
  });

  it('falls back to pane name', () => {
    const prompt = buildAdherencePrompt('output', undefined, 'auth-refactor');
    expect(prompt).toContain('auth-refactor');
  });
});

describe('parseAdherenceResponse', () => {
  it('parses valid JSON', () => {
    const result = parseAdherenceResponse(
      JSON.stringify({ onTrack: true, confidence: 0.9, reason: 'on task' })
    );
    expect(result).toEqual({ onTrack: true, confidence: 0.9, reason: 'on task' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseAdherenceResponse('nope')).toBeNull();
  });

  it('returns null when fields missing', () => {
    expect(parseAdherenceResponse(JSON.stringify({ onTrack: true }))).toBeNull();
  });

  it('clamps confidence to 0-1', () => {
    const result = parseAdherenceResponse(
      JSON.stringify({ onTrack: false, confidence: 1.5, reason: 'x' })
    );
    expect(result!.confidence).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- __tests__/adherenceCheck.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement and export adherence functions**

Add to `src/services/PaneAnalyzer.ts`:

```typescript
export interface AdherenceResult {
  onTrack: boolean;
  confidence: number;
  reason: string;
}

export function buildAdherencePrompt(
  paneContent: string,
  taskContext?: string,
  paneName?: string
): string {
  const task = taskContext
    || (paneName ? `Task inferred from branch: "${paneName}"` : 'Unknown task');
  return [
    `INTENDED TASK: ${task}`,
    '',
    'CURRENT TERMINAL OUTPUT (last 30 lines):',
    paneContent,
    '',
    'Is this agent on the intended task? JSON: {"onTrack": bool, "confidence": 0.0-1.0, "reason": "brief"}',
  ].join('\n');
}

export function parseAdherenceResponse(response: string): AdherenceResult | null {
  try {
    const data = JSON.parse(response);
    if (typeof data.onTrack !== 'boolean' || typeof data.confidence !== 'number' || typeof data.reason !== 'string') {
      return null;
    }
    return { onTrack: data.onTrack, confidence: Math.max(0, Math.min(1, data.confidence)), reason: data.reason };
  } catch { return null; }
}
```

- [ ] **Step 4: Extend Stage 3 to include adherence when task context available**

In the `extractSummary` method, append to the system prompt when `context.panePrompt` exists:

```typescript
const adherenceClause = context.panePrompt
  ? `\nAlso: is the agent on track with "${context.panePrompt}"? Add "adherence":{"onTrack":bool,"confidence":0.0-1.0,"reason":"brief"}`
  : '';
```

Parse `adherence` field from response and include in `PaneAnalysis`.

- [ ] **Step 5: Run tests**

Run: `pnpm run test -- __tests__/adherenceCheck.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/PaneAnalyzer.ts __tests__/adherenceCheck.test.ts
git commit -m "feat(dashboard): add task adherence evaluation to PaneAnalyzer"
```
## Task 9: Periodic Adherence Timer in StatusDetector

**Files:**
- Modify: `src/services/StatusDetector.ts`

- [ ] **Step 1: Read StatusDetector timer patterns**

Read `src/services/StatusDetector.ts` to understand how per-pane state and timers are managed. Note the existing `AbortController` pattern for LLM requests.

- [ ] **Step 2: Add adherence timer infrastructure**

Add fields to StatusDetector:

```typescript
private adherenceTimers = new Map<string, ReturnType<typeof setInterval>>();
private adherenceAbortControllers = new Map<string, AbortController>();
```

- [ ] **Step 3: Implement start/stop methods**

```typescript
private startAdherenceTimer(paneId: string, taskContext: string, paneName: string): void {
  this.stopAdherenceTimer(paneId);
  const interval = (this.settings?.adherenceCheckInterval ?? DEFAULT_ADHERENCE_CHECK_INTERVAL) * 1000;

  const timer = setInterval(async () => {
    const controller = new AbortController();
    this.adherenceAbortControllers.set(paneId, controller);
    try {
      const content = await capturePaneContent(paneId, 30);
      const userPrompt = buildAdherencePrompt(content, taskContext, paneName);
      const response = await this.provider.analyze(
        { system: 'Evaluate if an AI agent is on track with its task.', user: userPrompt, maxTokens: 60 },
        controller.signal
      );
      const result = parseAdherenceResponse(response);
      if (result && !result.onTrack && result.confidence > 0.7) {
        this.emit('status-updated', { paneId, status: 'working', needsAttention: true, adherence: result });
      }
    } catch { /* best-effort */ }
    finally { this.adherenceAbortControllers.delete(paneId); }
  }, interval);

  this.adherenceTimers.set(paneId, timer);
}

private stopAdherenceTimer(paneId: string): void {
  const timer = this.adherenceTimers.get(paneId);
  if (timer) { clearInterval(timer); this.adherenceTimers.delete(paneId); }
  const ctrl = this.adherenceAbortControllers.get(paneId);
  if (ctrl) { ctrl.abort(); this.adherenceAbortControllers.delete(paneId); }
}
```

- [ ] **Step 4: Wire into status transitions**

In the status change handler:
- `'working'` → `startAdherenceTimer(paneId, pane.taskContext || pane.prompt, pane.slug)`
- Any other status → `stopAdherenceTimer(paneId)`
- `'pane-removed'` → `stopAdherenceTimer(paneId)`

- [ ] **Step 5: Run typecheck and existing tests**

Run: `pnpm run typecheck && pnpm run test -- __tests__/paneStatusMonitoring.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/StatusDetector.ts
git commit -m "feat(dashboard): add periodic adherence check timer for working panes"
```

---

## Task 10: Task Context Capture on User Interaction

**Files:**
- Modify: `src/services/StatusDetector.ts`

- [ ] **Step 1: Capture content on user interaction**

In the existing `'pane-user-interaction'` handler, add task context capture:

```typescript
// After existing logic (cancel LLM, reset status):
try {
  const content = await capturePaneContent(paneId, 30);
  if (content.trim().length > 0) {
    this.emit('status-updated', { paneId, taskContext: content });
  }
} catch { /* best-effort */ }
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/StatusDetector.ts
git commit -m "feat(dashboard): capture user interaction content as task context"
```

---

## Task 11: Wire Provider into PaneAnalyzer

**Files:**
- Modify: `src/services/PaneAnalyzer.ts`

- [ ] **Step 1: Replace OpenRouter coupling with provider**

In `PaneAnalyzer`:
1. Remove `apiKey`, `modelStack`, `tryModel`, `makeRequestWithFallback` fields/methods
2. Add provider:

```typescript
import { createAnalysisProvider, type AnalysisProvider } from '../providers/AnalysisProvider.js';

export class PaneAnalyzer {
  private provider: AnalysisProvider;

  constructor() {
    const backend = (process.env.DMUX_ANALYSIS_BACKEND || 'auto') as any;
    this.provider = createAnalysisProvider(backend, {
      openRouterKey: process.env.OPENROUTER_API_KEY || '',
    });
  }
```

3. Replace all `makeRequestWithFallback(system, user, tokens, signal)` with:

```typescript
const raw = await this.provider.analyze({ system, user, maxTokens: tokens }, signal);
// Parse raw as JSON (provider returns content string)
```

- [ ] **Step 2: Run existing tests**

Run: `pnpm run test -- __tests__/paneAnalyzer.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/PaneAnalyzer.ts
git commit -m "refactor(dashboard): wire PaneAnalyzer to use provider interface"
```

---

## Task 12: Settings Validation

**Files:**
- Modify: `src/utils/settingsManager.ts`

- [ ] **Step 1: Add dashboard settings validation**

In `sanitizeLoadedSettings`, add:

```typescript
if (typeof parsed.dashboardRows === 'number' && Number.isInteger(parsed.dashboardRows)
    && parsed.dashboardRows >= 1 && parsed.dashboardRows <= 10) {
  sanitized.dashboardRows = parsed.dashboardRows;
}
if (typeof parsed.dashboardColumns === 'number' && Number.isInteger(parsed.dashboardColumns)
    && parsed.dashboardColumns >= 1 && parsed.dashboardColumns <= 10) {
  sanitized.dashboardColumns = parsed.dashboardColumns;
}
const ANALYSIS_BACKENDS = ['auto', 'claude-code', 'openrouter', 'heuristics'] as const;
if (typeof parsed.analysisBackend === 'string'
    && (ANALYSIS_BACKENDS as readonly string[]).includes(parsed.analysisBackend)) {
  sanitized.analysisBackend = parsed.analysisBackend as any;
}
if (typeof parsed.adherenceCheckInterval === 'number'
    && parsed.adherenceCheckInterval >= 10 && parsed.adherenceCheckInterval <= 300) {
  sanitized.adherenceCheckInterval = parsed.adherenceCheckInterval;
}
```

- [ ] **Step 2: Run settings tests**

Run: `pnpm run test -- __tests__/settingsManager.defaults.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/utils/settingsManager.ts
git commit -m "feat(dashboard): add dashboard settings validation"
```

---

## Task 13: Integrate Leader Key into Input Handling

**Files:**
- Modify: `src/hooks/useInputHandling.ts`

- [ ] **Step 1: Read useInputHandling structure**

Read `src/hooks/useInputHandling.ts` to find the `useInput` callback.

- [ ] **Step 2: Add leader key at top of input handler**

```typescript
import { useLeaderKey } from './useLeaderKey.js';

// Inside the hook, before useInput:
const { handleInput: handleLeaderInput } = useLeaderKey((action) => {
  switch (action) {
    case 'm': handleDashboardToggle(); break;
    case 'a': handleJumpToAttention(); break;
    default:
      if (action >= '1' && action <= '9') handleProjectToggle(parseInt(action, 10));
      break;
  }
});
```

In the `useInput` callback, add as first check:

```typescript
if (handleLeaderInput(input)) return;
```

- [ ] **Step 3: Add handler stubs (to be wired in Task 14)**

```typescript
const handleDashboardToggle = useCallback(() => {}, []);
const handleJumpToAttention = useCallback(() => {}, []);
const handleProjectToggle = useCallback((_n: number) => {}, []);
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useInputHandling.ts
git commit -m "feat(dashboard): integrate leader key into input handling"
```

---

## Task 14: Wire Dashboard into DmuxApp

**Files:**
- Modify: `src/DmuxApp.tsx`
- Modify: `src/hooks/useInputHandling.ts`
- Modify: `src/hooks/useLayoutManagement.ts`

- [ ] **Step 1: Add useDashboardMode to DmuxApp**

```typescript
import { useDashboardMode, getNextAttentionPane } from './hooks/useDashboardMode.js';

const dashboardMode = useDashboardMode({
  rows: settings.dashboardRows,
  columns: settings.dashboardColumns,
});
```

Pass `dashboardMode` to `useInputHandling` as a new option.

- [ ] **Step 2: Wire toggle handler**

In useInputHandling, replace the stub:

```typescript
const handleDashboardToggle = useCallback(() => {
  const updated = dashboardMode.toggle(panes);
  savePanes(updated);
}, [panes, dashboardMode, savePanes]);
```

- [ ] **Step 3: Wire attention jump handler**

```typescript
const handleJumpToAttention = useCallback(() => {
  const next = getNextAttentionPane(panes, focusedPaneId);
  if (next) {
    if (dashboardMode.active) dashboardMode.expandPane(next.paneId);
    const idx = panes.findIndex(p => p.id === next.id);
    if (idx !== -1) setSelectedIndex(idx);
  }
}, [panes, focusedPaneId, dashboardMode]);
```

- [ ] **Step 4: Wire project toggle handler**

```typescript
import { computeProjectToggle } from './useDashboardMode.js';

const handleProjectToggle = useCallback((n: number) => {
  const updated = computeProjectToggle(panes, n, sidebarProjects);
  savePanes(updated);
}, [panes, sidebarProjects, savePanes]);
```

- [ ] **Step 5: Route layout in useLayoutManagement**

Add early return when dashboard active:

```typescript
if (dashboardActive && wheel) {
  // Fixed geometry — only re-apply when slot membership changes, not on resize
  return;
}
```

- [ ] **Step 6: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/DmuxApp.tsx src/hooks/useInputHandling.ts src/hooks/useLayoutManagement.ts
git commit -m "feat(dashboard): wire dashboard mode into app with toggle and layout routing"
```
## Task 15: Visual Attention Borders

**Files:**
- Modify: `src/services/DmuxFocusService.ts`

- [ ] **Step 1: Read existing border/flash code**

Read `setPaneAttentionIndicator` and `flashPaneAttention` in `DmuxFocusService.ts`.

- [ ] **Step 2: Add wheel slot border methods**

Use `execFileSync` (from `src/utils/execFileNoThrow.ts` pattern) instead of `execSync` to avoid shell injection:

```typescript
import { execFileSync } from 'child_process';

async setWheelSlotBorder(tmuxPaneId: string, type: 'attention' | 'drift'): Promise<void> {
  const color = type === 'drift' ? 'red' : 'yellow';
  try {
    execFileSync('tmux', ['select-pane', '-t', tmuxPaneId, '-P', `border-style=fg=${color}`], { stdio: 'ignore' });
  } catch { /* pane may not exist */ }
}

async clearWheelSlotBorder(tmuxPaneId: string): Promise<void> {
  try {
    execFileSync('tmux', ['select-pane', '-t', tmuxPaneId, '-P', 'border-style=default'], { stdio: 'ignore' });
  } catch { /* pane may not exist */ }
}

async flashAndSetBorder(tmuxPaneId: string, type: 'attention' | 'drift'): Promise<void> {
  await this.flashPaneAttention(tmuxPaneId);
  await this.setWheelSlotBorder(tmuxPaneId, type);
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/DmuxFocusService.ts
git commit -m "feat(dashboard): add amber/red border management for wheel slot panes"
```

---

## Task 16: Claude Code Provider

**Files:**
- Create: `src/providers/ClaudeCodeProvider.ts`

- [ ] **Step 1: Implement ClaudeCodeProvider**

Create `src/providers/ClaudeCodeProvider.ts`:

```typescript
import type { AnalysisProvider, AnalysisPrompt } from './AnalysisProvider.js';
import { LogService } from '../services/LogService.js';

export class ClaudeCodeProvider implements AnalysisProvider {
  readonly name = 'claude-code';
  private sdk: any = null;

  constructor() {
    try {
      this.sdk = require('@anthropic-ai/claude-code');
    } catch {
      this.sdk = null;
    }
  }

  isAvailable(): boolean {
    return this.sdk !== null;
  }

  async analyze(prompt: AnalysisPrompt, signal?: AbortSignal): Promise<string> {
    if (!this.sdk) throw new Error('Claude Code SDK not available');

    try {
      const result = await this.sdk.query({
        prompt: prompt.user,
        systemPrompt: prompt.system,
        maxTokens: prompt.maxTokens,
        abortSignal: signal,
      });
      LogService.getInstance().debug('ClaudeCodeProvider: analysis complete', 'paneAnalyzer');
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Claude Code analysis failed: ${error}`);
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/providers/ClaudeCodeProvider.ts
git commit -m "feat(dashboard): add Claude Code SDK provider (optional, auto-detected)"
```

---

## Task 17: Wheel Layout tmux Integration

**Files:**
- Modify: `src/utils/layoutManager.ts`
- Modify: `src/layout/TmuxLayoutApplier.ts`

- [ ] **Step 1: Add wheel layout application path**

In `src/utils/layoutManager.ts`, add a new export:

```typescript
import { WheelLayoutManager } from '../layout/WheelLayoutManager.js';

export async function applyWheelLayout(
  controlPaneId: string,
  wheel: WheelLayoutManager,
  terminalWidth: number,
  terminalHeight: number,
  config?: LayoutConfig
): Promise<void> {
  const resolvedConfig = config ?? resolveLayoutConfig();
  const geo = wheel.calculateGeometry(terminalWidth, terminalHeight, resolvedConfig.SIDEBAR_WIDTH);
  const paneIds = wheel.getAllPaneIds();

  if (paneIds.length === 0) return;

  // Generate layout string using fixed wheel geometry
  const layoutString = generateSidebarGridLayout(
    controlPaneId,
    paneIds,
    resolvedConfig.SIDEBAR_WIDTH,
    terminalWidth,
    terminalHeight,
    geo.columns,
    resolvedConfig.MAX_COMFORTABLE_WIDTH
  );

  // Apply via TmuxLayoutApplier (reuse existing infrastructure)
  const applier = new TmuxLayoutApplier(resolvedConfig);
  applier.setWindowDimensions(terminalWidth, terminalHeight);
  applier.applyPaneLayout(controlPaneId, paneIds, {
    cols: geo.columns,
    rows: geo.rows,
    windowWidth: terminalWidth,
    paneDistribution: distributePanesEvenly(paneIds.length, geo.columns),
    actualPaneWidth: geo.paneWidth,
  }, terminalHeight);
}

function distributePanesEvenly(count: number, cols: number): number[] {
  const base = Math.floor(count / cols);
  const remainder = count % cols;
  return Array.from({ length: cols }, (_, i) => base + (i < remainder ? 1 : 0));
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/utils/layoutManager.ts
git commit -m "feat(dashboard): add wheel layout tmux application path"
```

---

## Task 18: Full Integration & Validation

**Files:** All

- [ ] **Step 1: Run full test suite**

Run: `pnpm run test`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Manual smoke test**

With `pnpm dev`:
- [ ] `Ctrl+\` then `m` toggles dashboard mode
- [ ] Working panes minimize with summary lines in sidebar
- [ ] Idle/waiting panes appear in wheel grid
- [ ] `Ctrl+\` then `a` cycles attention panes
- [ ] `Ctrl+\` then `1`-`9` toggles project panes
- [ ] Amber borders on attention panes in wheel
- [ ] Panes re-minimize when agent resumes working
- [ ] Manual splits unaffected by dashboard mode
- [ ] `h` key hide works independently of minimize
- [ ] No resize churn when panes enter/exit wheel

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "fix(dashboard): integration fixups from smoke testing"
```
