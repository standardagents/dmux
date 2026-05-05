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
