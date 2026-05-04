# Design: Dashboard Mode & Attention-Driven Layout

## Overview

When running many parallel agents (6+), the current grid layout wastes screen space on panes that are happily working. Dashboard mode collapses working agents to enhanced sidebar status lines and uses a stable "wheel" grid to display only panes that need attention — without resize churn.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Minimized pane display | Enhanced PaneCard with summary line | Reuses existing sidebar component, no new UI regions |
| Summary content | LLM-generated text encodes on-track confidence | No extra badge/chrome, information-dense |
| Drift detection trigger | Soft — `!` marker + amber border, not auto-expand | Avoids disruptive false positives from LLM misjudgment |
| Jump to flagged panes | `!` hotkey cycles through attention-flagged panes | Fast path without mouse navigation |
| Dashboard activation | User-toggled via `M` hotkey | Opt-in, no surprise behavior changes |
| Grid geometry | Fixed wheel layout — configurable rows x columns (default 2x4) | Zero resize churn during expand/collapse cycles |
| LLM backend | Provider abstraction with auto-detection | Works without API keys if Claude Code is installed |
| Split pane handling | Excluded from minimization | Respects user-created manual splits |

## Data Model

### DmuxPane extensions

```typescript
interface DmuxPane {
  // ... existing fields
  minimized?: boolean;    // true when dashboard mode has collapsed this pane
  taskContext?: string;   // latest "intended task" — stored prompt or last user input
}
```

`minimized` is distinct from `hidden`. Hidden = user explicitly hid via `h` key. Minimized = dashboard mode auto-collapsed. Toggling dashboard off only restores minimized panes; manually hidden panes stay hidden.

### PaneAnalysis extensions

```typescript
interface PaneAnalysis {
  // ... existing fields (state, summary, options, potentialHarm, attentionTitle, attentionBody)
  adherence?: {
    onTrack: boolean;
    confidence: number;   // 0.0 - 1.0
    reason: string;       // short explanation, folded into summary text
  };
}
```

### Settings extensions

```typescript
interface DashboardSettings {
  dashboardRows: number;          // default: 2
  dashboardColumns: number;       // default: 4
  analysisBackend: 'auto' | 'claude-code' | 'openrouter' | 'heuristics'; // default: 'auto'
  adherenceCheckInterval: number; // seconds, default: 45
}
```

## Architecture

### Subsystem 1: Analysis Provider Abstraction

Extract the current OpenRouter-specific `makeRequestWithFallback` into a provider interface:

```typescript
interface AnalysisProvider {
  analyze(
    prompt: { system: string; user: string; maxTokens: number },
    signal?: AbortSignal
  ): Promise<string>;
  isAvailable(): boolean;
}
```

Three implementations:

| Provider | Auth | When used |
|----------|------|-----------|
| `ClaudeCodeProvider` | Claude Code subscription (SDK handles auth) | `@anthropic-ai/claude-code` importable |
| `OpenRouterProvider` | `OPENROUTER_API_KEY` env var | API key present |
| `HeuristicsOnlyProvider` | None | Fallback — no LLM, returns `in_progress` always |

Auto-detection order: Claude Code SDK → OpenRouter → heuristics-only. User can override via `analysisBackend` setting.

### Subsystem 2: Task Adherence Analysis (Hybrid)

Two analysis paths depending on pane state:

**Path A — Extended Stage 3 (idle/prompt panes):**

Triggered when a pane settles to `idle` or `open_prompt`. Extends the existing Stage 3 LLM call to also return adherence fields. The prompt receives pane content + task context and asks for summary + onTrack + confidence + reason in one call.

- Token budget: ~250 output tokens
- Trigger: pane state transition to idle/prompt (existing flow)

**Path B — Periodic working check:**

A lightweight LLM call on a timer (default 45s) for panes in `working` state. Sends last 30 lines of output + task context. Asks only: "is this agent working on [task]?" Returns onTrack/confidence/reason.

- Token budget: ~60 output tokens
- Trigger: timer in StatusDetector, per-pane, with deduplication and cancellation on state change
- Uses the cheapest available model (or Claude Code with minimal context)

**Task context capture:**

The "intended task" for adherence evaluation comes from (priority order):
1. Last meaningful user input — captured when `isLikelyUserTyping()` fires, stores surrounding content
2. Stored initial prompt (`panePrompt` from pane creation)
3. Branch name / pane name (lowest confidence)

The `taskContext` field on `DmuxPane` updates whenever user interaction is detected.

**Drift → Attention:**

When periodic check returns `{ onTrack: false, confidence: > 0.7 }`:
- Set `needsAttention: true` on the pane
- PaneCard shows `!` marker
- Does NOT auto-expand (soft trigger)
- `!` hotkey jumps to flagged panes
- When pane enters a wheel slot (manual expand or hotkey), border turns amber/red

### Subsystem 3: Dashboard Mode Layout (Wheel Queue)

When dashboard mode is active, the layout system switches from the scoring-based `LayoutCalculator` to a fixed-geometry wheel:

**Grid properties:**
- Fixed at `dashboardRows x dashboardColumns` (default 2x4 = 8 slots)
- Geometry set once when dashboard mode activates, never changes during the session
- Sidebar width remains 40 chars; content area divides evenly among columns

**Fill order:**
- Row-major: top-left (slot 1) → top-right → bottom-left → bottom-right (slot N)
- Slot 1 is the primary focus point

**Shift on resolve:**
- When a pane in slot N is resolved (re-minimized after user interaction + agent resumes working), all panes in slots N+1..last shift down by one
- No geometry change, only pane reassignment within fixed slots

**Overflow:**
- If more panes need attention than available slots, extras stay minimized in the sidebar with `!` markers
- They auto-fill as slots free up, in FIFO order (time of first attention request)

**Empty slots:**
- Rendered as spacer panes (existing `SpacerManager` pattern)

**What enters a wheel slot:**
- Panes with `agentStatus === 'idle' | 'waiting'` (finished or asking for input)
- Panes the user manually expands via `!` hotkey (drift-flagged)
- NOT automatically for drift — drift is soft (marker only)

**What exits a wheel slot (re-minimizes):**
- Agent resumes `working` state after user interaction
- User manually minimizes (select + `M` on the pane, or pane-specific action)

### Subsystem 4: Split Pane Handling

User-created tmux splits are detected by `PaneEventService` and excluded from dashboard management:

- When a new pane appears that is a child split of an existing wheel slot pane, it coexists within that slot's allocated space
- The sub-split stays entirely within the parent slot's geometry — other slots are unaffected
- Split panes are never auto-minimized
- When the parent pane is re-minimized, child splits remain visible and are promoted to their own wheel slot (they represent independent user work that must not be disrupted)

### Subsystem 5: Visual Attention Signals

**Amber border (attention needed):**
- Set via tmux `pane-border-style fg=yellow` when a pane enters a wheel slot
- Removed when pane exits the wheel slot

**Red border (drift detected):**
- Set via tmux `pane-border-style fg=red` when a drift-flagged pane is expanded
- Distinguishes "needs input" (amber) from "off track" (red)

**Flash on arrival:**
- Existing `flashPaneAttention()` 12-step sequence triggers when a pane first enters a wheel slot
- After flash settles, steady amber/red border remains

### Subsystem 6: Sidebar Rendering

When `pane.minimized === true` and an `agentSummary` exists, PaneCard renders a second line:

```
 ✻ auth-refactor                [cl]
   Implementing token validation
 ✻ db-migrate                   [cl]
   Writing schema (on track)
 ◌ ui-refresh                   [cl]
   Done — ready to merge
!✻ ontology-refac               [cl]
   Refactoring unrelated tests (drifted)
```

- Summary line is indented 3 chars, truncated to fit 37 chars (40 - indent)
- Only shown for minimized panes (non-minimized panes render as today)
- `!` attention marker and existing status icons remain unchanged

## Keybindings

| Key | Action | Context |
|-----|--------|---------|
| `M` | Toggle dashboard mode | Global — switches between grid mode and wheel mode |
| `!` | Jump to next attention-flagged pane | Global — cycles through panes with `needsAttention: true`. In dashboard mode: expands flagged pane into next free wheel slot. Outside dashboard mode: navigates sidebar selection to next flagged pane. |

## State Transitions

```
Dashboard OFF (grid mode):
  All panes visible in scored grid layout (current behavior)
  Status icons show in sidebar
  No summary lines (current PaneCard rendering)

  User presses M →

Dashboard ON (wheel mode):
  Working panes → minimized: true (removed from tmux grid, shown in sidebar with summary)
  Idle/waiting panes → fill wheel slots (FIFO)
  Drift-flagged panes → stay minimized with ! marker until user presses !

  Pane finishes (idle) → enters next free wheel slot, amber border, flash
  User interacts → agent resumes working → pane re-minimizes, shifts remaining slots
  User presses ! → next flagged pane expands into a wheel slot (red border if drift)

  User presses M →

Dashboard OFF:
  All minimized panes → minimized: false
  Layout reverts to scored grid calculation
  Manually hidden panes stay hidden
```

## Constraints

- Must not break existing layout behavior — dashboard mode is opt-in via `M` hotkey
- Must work without any LLM backend — heuristics-only provider gracefully degrades (no summary text, no adherence, but dashboard toggle and wheel layout still function)
- Should degrade gracefully on non-macOS (no native focus helper — amber borders still work via tmux pane options)
- Split panes are never auto-minimized
- PR should follow existing code patterns (EventEmitter services, React hooks, memoized components)

## Files to Create/Modify

### New files:
- `src/providers/AnalysisProvider.ts` — interface + auto-detection
- `src/providers/ClaudeCodeProvider.ts` — Claude Code SDK implementation
- `src/providers/OpenRouterProvider.ts` — extracted from PaneAnalyzer
- `src/providers/HeuristicsOnlyProvider.ts` — no-op fallback
- `src/layout/WheelLayoutManager.ts` — fixed-geometry layout for dashboard mode
- `src/hooks/useDashboardMode.ts` — dashboard state, toggle logic, pane minimization

### Modified files:
- `src/services/PaneAnalyzer.ts` — use provider interface, add adherence to Stage 3
- `src/services/StatusDetector.ts` — add periodic adherence check timer for working panes
- `src/types.ts` — add `minimized`, `taskContext` to DmuxPane
- `src/components/panes/PaneCard.tsx` — render summary line for minimized panes
- `src/hooks/useInputHandling.ts` — add `M` and `!` keybindings
- `src/hooks/useLayoutManagement.ts` — route to wheel layout when dashboard active
- `src/utils/layoutManager.ts` — integrate WheelLayoutManager
- `src/utils/paneVisibility.ts` — exclude minimized panes from grid (like hidden)
- `src/services/DmuxFocusService.ts` — amber/red border management
- `src/actions/types.ts` — add dashboard-related actions to registry
- `src/utils/settingsManager.ts` — add dashboard settings
- `src/constants/layout.ts` — add dashboard defaults
