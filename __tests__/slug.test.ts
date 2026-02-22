import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock agentHarness
vi.mock('../src/utils/agentHarness.js', () => ({
  callAgent: vi.fn(),
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

// Mock settingsManager (will be overridden per test via vi.doMock)
let mockSlugProvider: string = 'auto';
vi.mock('../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn().mockImplementation(() => ({
    getSettings: () => ({ slugProvider: mockSlugProvider }),
  })),
}));

import { callAgent } from '../src/utils/agentHarness.js';
const mockCallAgent = vi.mocked(callAgent);

describe('slug generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlugProvider = 'auto';
    delete process.env.OPENROUTER_API_KEY;
  });

  it('falls back to timestamp when prompt is empty', async () => {
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('');
    expect(slug).toMatch(/^dmux-\d+$/);
    expect(mockCallAgent).not.toHaveBeenCalled();
  });

  it('returns sanitized slug from local agent', async () => {
    mockCallAgent.mockResolvedValue('Fix-Auth');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('fix the auth bug');
    expect(slug).toBe('fix-auth');
  });

  it('strips non-alphanumeric characters from agent response', async () => {
    mockCallAgent.mockResolvedValue('  "fix_auth!" ');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('fix auth');
    expect(slug).toBe('fixauth');
  });

  it('falls back to timestamp when agent returns empty', async () => {
    mockCallAgent.mockResolvedValue(null);
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('do something');
    expect(slug).toMatch(/^dmux-\d+$/);
  });

  it('falls back to timestamp when agent returns only special chars', async () => {
    mockCallAgent.mockResolvedValue('!!!');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('do something');
    expect(slug).toMatch(/^dmux-\d+$/);
  });

  it('calls agent with cheap model tier', async () => {
    mockCallAgent.mockResolvedValue('my-slug');
    const { generateSlug } = await import('../src/utils/slug.js');
    await generateSlug('some prompt');
    expect(mockCallAgent).toHaveBeenCalledWith(
      expect.stringContaining('some prompt'),
      expect.objectContaining({ cheap: true })
    );
  });
});

describe('slug provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('uses local agent when provider is "auto"', async () => {
    mockSlugProvider = 'auto';
    mockCallAgent.mockResolvedValue('auto-slug');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('test prompt');
    expect(slug).toBe('auto-slug');
    expect(mockCallAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cheap: true })
    );
    // Should NOT pass a specific agent — let resolveAgent decide
    expect(mockCallAgent.mock.calls[0][1]?.agent).toBeUndefined();
  });

  it('forces claude agent when provider is "claude"', async () => {
    mockSlugProvider = 'claude';
    mockCallAgent.mockResolvedValue('claude-slug');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('test prompt');
    expect(slug).toBe('claude-slug');
    expect(mockCallAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agent: 'claude' })
    );
  });

  it('forces codex agent when provider is "codex"', async () => {
    mockSlugProvider = 'codex';
    mockCallAgent.mockResolvedValue('codex-slug');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('test prompt');
    expect(slug).toBe('codex-slug');
    expect(mockCallAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agent: 'codex' })
    );
  });

  it('tries OpenRouter first when provider is "openrouter" (no key = falls back)', async () => {
    mockSlugProvider = 'openrouter';
    // No OPENROUTER_API_KEY → OpenRouter fails → falls back to local agent
    mockCallAgent.mockResolvedValue('fallback-slug');
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('test prompt');
    expect(slug).toBe('fallback-slug');
    // Should have called local agent as fallback
    expect(mockCallAgent).toHaveBeenCalled();
  });

  it('openrouter provider falls back to timestamp when both fail', async () => {
    mockSlugProvider = 'openrouter';
    mockCallAgent.mockResolvedValue(null);
    const { generateSlug } = await import('../src/utils/slug.js');
    const slug = await generateSlug('test prompt');
    expect(slug).toMatch(/^dmux-\d+$/);
  });
});
