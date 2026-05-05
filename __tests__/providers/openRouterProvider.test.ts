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
