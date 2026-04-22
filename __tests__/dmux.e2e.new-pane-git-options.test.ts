import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';

function hasCmd(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectPopupRunner(): string | null {
  const distPath = path.join(process.cwd(), 'dist', 'components', 'popups', 'newPanePopup.js');
  if (fs.existsSync(distPath)) {
    return `node "${distPath}"`;
  }

  if (hasCmd('pnpm')) {
    return 'pnpm exec tsx "src/components/popups/newPanePopup.tsx"';
  }

  if (hasCmd('tsx')) {
    return 'tsx "src/components/popups/newPanePopup.tsx"';
  }

  return null;
}

function getLocalBranchesByRecentCommit(): string[] {
  const raw = execSync(
    "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads",
    { encoding: 'utf-8', stdio: 'pipe' }
  );

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function poll<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15000,
  intervalMs = 200
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

function capturePane(server: string, session: string): string {
  return execSync(`tmux -L ${server} capture-pane -p -t ${session}:0.0`, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

async function waitForPaneText(
  server: string,
  session: string,
  expectedText: string,
  timeoutMs = 15000
): Promise<void> {
  let lastPaneText = '';
  try {
    await poll(
      () => {
        const paneText = capturePane(server, session);
        lastPaneText = paneText;
        return paneText;
      },
      (paneText) => paneText.includes(expectedText),
      timeoutMs,
      150
    );
  } catch {
    throw new Error(
      `Timed out waiting for pane text: "${expectedText}"\nLast pane:\n${lastPaneText}`
    );
  }
}

async function readPopupResult(resultFile: string): Promise<any | null> {
  try {
    const raw = await fsp.readFile(resultFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const runE2E = process.env.DMUX_E2E === '1';
const popupRunner = detectPopupRunner();
const canRun = runE2E && hasCmd('tmux') && !!popupRunner;

describe.sequential('dmux e2e: new pane git options popup', () => {
  it.runIf(canRun)('writes prompt + base branch + branch override payload', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-ok';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const existingBaseBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'e2e prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${existingBaseBranch}'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });

      // Type explicit branch/worktree override and submit.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-git-options'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      const payload = await poll(
        async () => {
          try {
            const raw = await fsp.readFile(resultFile, 'utf-8');
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
        (value) => !!value
      );

      expect(payload.success).toBe(true);
      expect(payload.data.prompt).toBe('e2e prompt');
      expect(payload.data.branchName).toBe('feat/e2e-git-options');
      expect(payload.data.baseBranch).toBe(existingBaseBranch);
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('rejects non-existent base branch overrides (strict mode)', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-strict';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'strict mode prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      // Type a non-existent branch, then continue to branch-name field and attempt submit.
      await waitForPaneText(server, session, 'Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'branch-that-should-not-exist-12345'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-invalid-base'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await sleep(800);

      // Strict validation should block submission, so no result file yet.
      const resultExists = fs.existsSync(resultFile);
      expect(resultExists).toBe(false);
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('cycles prompt/base/branch with Tab and Shift+Tab', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-cycle';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const existingBaseBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'cycle prompt'`, { stdio: 'pipe' });
      await waitForPaneText(server, session, 'cycle prompt');

      // Enter from prompt -> base branch field.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${existingBaseBranch}'`, { stdio: 'pipe' });

      // Tab from base -> branch field.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-cycle'`, { stdio: 'pipe' });

      // Tab from branch -> prompt.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 ' updated'`, { stdio: 'pipe' });

      // Tab prompt -> base, then Shift+Tab (BTab) base -> prompt.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 BTab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');

      // Return to branch and submit.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');

      // Submit from branch field.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      const payload = await poll(
        () => readPopupResult(resultFile),
        (value) => !!value
      );

      expect(payload.success).toBe(true);
      expect(typeof payload.data.prompt).toBe('string');
      expect(payload.data.prompt.trim().length).toBeGreaterThan(0);
      expect(payload.data.prompt).toContain('updated');
      expect(payload.data.baseBranch).toBe(existingBaseBranch);
      expect(payload.data.branchName).toBe('feat/e2e-cycle');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('does not auto-accept highlighted base branch when tabbing fields', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-tab-noaccept';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const existingBaseBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    const partialBase = existingBaseBranch.slice(0, Math.min(3, existingBaseBranch.length));

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'tab no accept prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, '▶ Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${partialBase}'`, { stdio: 'pipe' });

      // Tab to branch field should not auto-select highlighted branch.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Tab`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-tab-noaccept'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await sleep(700);
      expect(fs.existsSync(resultFile)).toBe(false);
      await waitForPaneText(server, session, 'Base branch must match an existing local branch');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('accepts highlighted branch on Enter after typing partial branch text', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-enter-fill';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const branches = getLocalBranchesByRecentCommit();
    const topBranch = branches[0];
    const partial = topBranch.slice(0, Math.min(3, topBranch.length));
    const expectedBranch = branches.find((branch) => branch.toLowerCase().includes(partial.toLowerCase())) || topBranch;

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'enter fill prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, '▶ Base branch override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${partial}'`, { stdio: 'pipe' });

      // Enter should accept highlighted branch and move to branch-name field.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-enter-fill'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      const payload = await poll(
        () => readPopupResult(resultFile),
        (value) => !!value
      );

      expect(payload.success).toBe(true);
      expect(payload.data.baseBranch).toBe(expectedBranch);
      expect(payload.data.branchName).toBe('feat/e2e-enter-fill');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('uses up/down arrows to change highlighted branch before Enter', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-arrows';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const branches = getLocalBranchesByRecentCommit();

    // We need at least two branches to verify down-arrow selection change.
    expect(branches.length).toBeGreaterThan(1);
    const expectedSelected = branches[1];

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'arrow selection prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, '▶ Base branch override (optional)');

      // Down selects second branch, up returns to first, down selects second again.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Down`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Up`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Down`, { stdio: 'pipe' });

      // Enter should accept current highlighted branch.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-arrow-select'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      const payload = await poll(
        () => readPopupResult(resultFile),
        (value) => !!value
      );

      expect(payload.success).toBe(true);
      expect(payload.data.baseBranch).toBe(expectedSelected);
      expect(payload.data.branchName).toBe('feat/e2e-arrow-select');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('treats Delete key as forward-delete in base branch input', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-delete-forward';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const existingBaseBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'delete forward prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, '▶ Base branch override (optional)');

      // Build base branch value and put cursor before trailing marker char.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${existingBaseBranch}x'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Left`, { stdio: 'pipe' });

      // Delete should remove the char to the right (x), preserving the valid base branch.
      // Use a literal escape sequence to avoid tmux key-name normalization ambiguity.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 -l "$(printf '\\033[3~')"`, { stdio: 'pipe' });

      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });
      await waitForPaneText(server, session, '▶ Branch/worktree name override (optional)');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'feat/e2e-delete-forward'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      const payload = await poll(
        () => readPopupResult(resultFile),
        (value) => !!value
      );

      expect(payload.success).toBe(true);
      expect(payload.data.baseBranch).toBe(existingBaseBranch);
      expect(payload.data.branchName).toBe('feat/e2e-delete-forward');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(canRun)('uses Backspace as left-delete in base branch input', async () => {
    const server = `dmux-e2e-gitopt-${Date.now()}`;
    const session = 'dmux-e2e-gitopt-backspace-left';
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dmux-e2e-gitopt-'));
    const resultFile = path.join(tempDir, 'result.json');
    const existingBaseBranch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    try {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}

      execSync(`tmux -L ${server} -f /dev/null new-session -d -s ${session} -n main bash`, { stdio: 'pipe' });

      const popupCommand = `${popupRunner} "${resultFile}" "${process.cwd()}" 1`;
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${popupCommand}' Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, 'Enter a prompt for your AI agent.');
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 'backspace left prompt'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await waitForPaneText(server, session, '▶ Base branch override (optional)');

      // Build base branch value and put cursor before trailing marker char.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 '${existingBaseBranch}x'`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Left`, { stdio: 'pipe' });

      // Backspace should remove the char to the left of cursor, leaving an invalid
      // branch text (existing branch minus last char + trailing marker), so submit
      // should be blocked by strict validation.
      // Use a literal DEL byte to match real backspace terminal behavior.
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 -l "$(printf '\\177')"`, { stdio: 'pipe' });
      execSync(`tmux -L ${server} send-keys -t ${session}:0.0 Enter`, { stdio: 'pipe' });

      await sleep(700);
      expect(fs.existsSync(resultFile)).toBe(false);
      await waitForPaneText(server, session, 'Base branch must match an existing local branch');
    } finally {
      try { execSync(`tmux -L ${server} kill-session -t ${session}`, { stdio: 'pipe' }); } catch {}
      try { execSync(`tmux -L ${server} kill-server`, { stdio: 'pipe' }); } catch {}
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
  }, 120000);

  it.runIf(!canRun)('skipped: tmux or popup runner unavailable', () => {
    // Intentionally empty
  });
});
