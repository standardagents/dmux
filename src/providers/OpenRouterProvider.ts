import type { AnalysisProvider, AnalysisPrompt } from './AnalysisProvider.js';
import { LogService } from '../services/LogService.js';

export class OpenRouterProvider implements AnalysisProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private modelStack = [
    'google/gemini-2.5-flash',
    'x-ai/grok-4-fast:free',
    'openai/gpt-4o-mini',
  ];

  constructor(apiKey: string) { this.apiKey = apiKey; }

  isAvailable(): boolean { return this.apiKey.length > 0; }

  async analyze(prompt: AnalysisPrompt, signal?: AbortSignal): Promise<string> {
    if (!this.apiKey) throw new Error('OpenRouter API key not available');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      return await Promise.any(
        this.modelStack.map(model => this.tryModel(model, prompt, combinedSignal))
      );
    } catch (error) {
      if (error instanceof AggregateError) {
        throw error.errors[0] || new Error('All models failed');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async tryModel(model: string, prompt: AnalysisPrompt, signal: AbortSignal): Promise<string> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/dmux/dmux',
        'X-Title': 'dmux',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.1,
        max_tokens: prompt.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`API error (${model}): ${response.status}`);
    }
    const data = await response.json() as any;
    LogService.getInstance().debug(`OpenRouterProvider: ${model} succeeded`, 'paneAnalyzer');
    return data.choices?.[0]?.message?.content || '';
  }
}
