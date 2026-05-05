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
