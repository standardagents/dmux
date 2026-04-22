# Contributing to dmux

This project is built while running dmux itself. The goal is a fast, repeatable loop for maintainers and contributors.

## Prerequisites

- Node.js 18+
- `pnpm`
- `tmux` 3.0+

## Local Development (Dogfood Loop)

1. Install dependencies:

```bash
pnpm install
```

2. Start dmux in local dev mode:

```bash
pnpm dev
```

`pnpm dev` is the standard maintainer entrypoint for this repo. It bootstraps local dmux development requirements, compiles TypeScript, then launches dmux from `dist/index.js` with `DMUX_DEV=true`. Inside tmux it auto-promotes to a watch loop so TypeScript changes rebuild and restart automatically.

If reload behavior looks wrong, run:

```bash
pnpm run dev:doctor
```

This verifies watch mode, source path, control pane health, and local hooks/docs bootstrap state.

## Recommended Daily Workflow

1. Keep one long-lived maintainer worktree for running local dmux (`pnpm dev`).
2. Create feature panes/worktrees from dmux (`n`) for actual changes.
3. Iterate in feature worktree panes and merge from dmux (`m`).
4. Close panes with "Just close pane" when done (`x`) to keep worktrees available.
5. Reopen closed worktrees with `r` when you need to resume work.

In DEV mode, source switching is toggled from the pane menu (`[DEV] Use as Source`) or hotkey (`S`):

- Select any worktree pane and run source toggle -> that worktree becomes active source.
- Toggle again on the already-active source pane -> source falls back to project root.
- If the active source worktree is closed/removed, dmux automatically falls back to project root.
- The active source pane is marked with `[source]` in the pane list.

This keeps the dev session stable while still using pane-per-branch isolation.

## Bootstrap Behavior

`pnpm dev` runs `dev:bootstrap` first:

- `worktree_created`: bootstraps dependencies in new worktrees
- `pre_merge`: runs `typecheck` and tests before merge
- hook docs generation: creates `src/utils/generated-agents-doc.ts`

You can run bootstrap manually:

```bash
pnpm run dev:bootstrap
```

Use `pnpm run hooks:install-local -- --force` to overwrite existing hook files.

## E2E Test Suite

dmux includes tmux-driven end-to-end tests under `__tests__/dmux.e2e.*.test.ts`.

- E2E tests are opt-in and skipped by default.
- They require `tmux` plus a runnable dmux entrypoint (`dist/index.js`, `pnpm`, or `tsx`).

Run all e2e tests:

```bash
DMUX_E2E=1 pnpm exec vitest --run __tests__/dmux.e2e.*.test.ts
```

Run one e2e file:

```bash
DMUX_E2E=1 pnpm exec vitest --run __tests__/dmux.e2e.create-pane.test.ts
```

## Pull Request Workflow

1. One pane/worktree per PR branch.
2. Merge through dmux when possible (this dogfoods merge + cleanup paths).
3. Ensure local checks pass:

```bash
pnpm run typecheck
pnpm run test
```

4. Open PR from the feature branch created for that pane.

## Maintainer Checklist (Before Release)

```bash
pnpm run clean
pnpm run build
pnpm run typecheck
pnpm run test
```
