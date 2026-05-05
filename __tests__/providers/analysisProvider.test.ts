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
