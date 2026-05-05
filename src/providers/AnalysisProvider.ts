import { OpenRouterProvider } from './OpenRouterProvider.js';
import { HeuristicsOnlyProvider } from './HeuristicsOnlyProvider.js';

export interface AnalysisPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

export interface AnalysisProvider {
  analyze(prompt: AnalysisPrompt, signal?: AbortSignal): Promise<string>;
  isAvailable(): boolean;
  readonly name: string;
}

export interface ProviderOptions {
  openRouterKey?: string;
  claudeCodeAvailable?: boolean;
}

export function createAnalysisProvider(
  backend: 'auto' | 'claude-code' | 'openrouter' | 'heuristics',
  options: ProviderOptions = {}
): AnalysisProvider {
  const { openRouterKey = process.env.OPENROUTER_API_KEY || '' } = options;

  switch (backend) {
    case 'openrouter': {
      return new OpenRouterProvider(openRouterKey);
    }
    case 'claude-code': {
      // ClaudeCodeProvider is not yet implemented; fall through to heuristics
      return new HeuristicsOnlyProvider();
    }
    case 'heuristics': {
      return new HeuristicsOnlyProvider();
    }
    case 'auto':
    default: {
      if (openRouterKey) {
        const p = new OpenRouterProvider(openRouterKey);
        if (p.isAvailable()) return p;
      }
      return new HeuristicsOnlyProvider();
    }
  }
}
