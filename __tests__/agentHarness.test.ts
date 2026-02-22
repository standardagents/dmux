import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before any imports
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock agent detection
vi.mock('../src/utils/agentDetection.js', () => ({
  getAvailableAgents: vi.fn(),
}));

// Mock settings manager
vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn().mockImplementation(() => ({
    getSettings: () => ({}),
  })),
}));

// Mock LogService
vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { execSync } from 'child_process';
import { getAvailableAgents } from '../src/utils/agentDetection.js';
import { resolveAgent, callAgent } from '../src/utils/agentHarness.js';

const mockExecSync = vi.mocked(execSync);
const mockGetAvailableAgents = vi.mocked(getAvailableAgents);

describe('resolveAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns preferred agent when available', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude', 'codex']);
    expect(await resolveAgent('codex')).toBe('codex');
  });

  it('falls back to first available when preferred is not installed', async () => {
    mockGetAvailableAgents.mockResolvedValue(['opencode']);
    expect(await resolveAgent('claude')).toBe('opencode');
  });

  it('returns null when no agents available', async () => {
    mockGetAvailableAgents.mockResolvedValue([]);
    expect(await resolveAgent()).toBeNull();
  });

  it('returns first available agent with no preference', async () => {
    mockGetAvailableAgents.mockResolvedValue(['codex', 'claude']);
    expect(await resolveAgent()).toBe('codex');
  });
});

describe('callAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any leftover temp files (best-effort)
    vi.restoreAllMocks();
  });

  it('returns null when no agent is available', async () => {
    mockGetAvailableAgents.mockResolvedValue([]);
    const result = await callAgent('test prompt');
    expect(result).toBeNull();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('calls claude with --print flag', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('test-response\n');

    const result = await callAgent('hello', { agent: 'claude' });

    expect(result).toBe('test-response');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('claude --print');
    expect(cmd).toContain('2>/dev/null');
  });

  it('calls codex with --quiet flag', async () => {
    mockGetAvailableAgents.mockResolvedValue(['codex']);
    mockExecSync.mockReturnValue('codex-response\n');

    const result = await callAgent('hello', { agent: 'codex' });

    expect(result).toBe('codex-response');
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('codex --quiet');
  });

  it('calls opencode with run subcommand', async () => {
    mockGetAvailableAgents.mockResolvedValue(['opencode']);
    mockExecSync.mockReturnValue('opencode-response\n');

    const result = await callAgent('hello', { agent: 'opencode' });

    expect(result).toBe('opencode-response');
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('opencode run');
  });

  it('adds model flag for cheap tier (claude)', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('response');

    await callAgent('hello', { agent: 'claude', cheap: true });

    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('--model haiku');
  });

  it('adds model flag for mid tier (claude)', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('response');

    await callAgent('hello', { agent: 'claude', model: 'mid' });

    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('--model sonnet');
  });

  it('strips markdown fences in json mode', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('```json\n{"key": "value"}\n```\n');

    const result = await callAgent('hello', { agent: 'claude', json: true });

    expect(result).toBe('{"key": "value"}');
  });

  it('returns null on exec failure', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockImplementation(() => {
      throw new Error('Command failed');
    });

    const result = await callAgent('hello', { agent: 'claude' });
    expect(result).toBeNull();
  });

  it('returns null on empty output', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('   \n');

    const result = await callAgent('hello', { agent: 'claude' });
    expect(result).toBeNull();
  });

  it('respects timeout option', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('ok');

    await callAgent('hello', { agent: 'claude', timeout: 30000 });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 30000 })
    );
  });

  it('removes CLAUDECODE env var for nested calls', async () => {
    mockGetAvailableAgents.mockResolvedValue(['claude']);
    mockExecSync.mockReturnValue('ok');

    // Set CLAUDECODE in process.env temporarily
    process.env.CLAUDECODE = '1';

    await callAgent('hello', { agent: 'claude' });

    const passedEnv = (mockExecSync.mock.calls[0][1] as any).env;
    expect(passedEnv.CLAUDECODE).toBeUndefined();

    delete process.env.CLAUDECODE;
  });
});
