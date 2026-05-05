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
