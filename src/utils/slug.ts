import { callAgent } from './agentHarness.js';
import { LogService } from '../services/LogService.js';

const SLUG_PROMPT = (prompt: string) =>
  `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`;

const OPENROUTER_MODELS = [
  'google/gemini-2.5-flash',
  'x-ai/grok-4-fast:free',
  'openai/gpt-4o-mini',
];

/**
 * Read the slugProvider setting (lazy import to match agentHarness.ts pattern).
 */
async function resolveProvider(): Promise<'auto' | 'openrouter' | 'claude' | 'codex'> {
  try {
    const { SettingsManager } = await import('./settingsManager.js');
    const settings = new SettingsManager().getSettings();
    return settings.slugProvider ?? 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Call OpenRouter API with model rotation fallback.
 * Returns raw slug text or null on failure.
 */
async function callOpenRouter(prompt: string): Promise<string | null> {
  const logger = LogService.getInstance();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.warn('OPENROUTER_API_KEY not set — cannot use OpenRouter for slug generation', 'slug');
    return null;
  }

  for (const model of OPENROUTER_MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: SLUG_PROMPT(prompt) }],
          max_tokens: 32,
        }),
      });

      if (!response.ok) {
        logger.debug(`OpenRouter ${model} returned ${response.status}`, 'slug');
        continue;
      }

      const data = await response.json() as any;
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text;
    } catch (error) {
      logger.debug(`OpenRouter ${model} failed: ${error instanceof Error ? error.message : error}`, 'slug');
    }
  }

  return null;
}

/**
 * Call a local agent CLI for slug generation.
 */
async function callLocalAgent(prompt: string, agent?: 'claude' | 'codex'): Promise<string | null> {
  return callAgent(SLUG_PROMPT(prompt), { timeout: 60000, cheap: true, agent });
}

/**
 * Sanitize raw LLM output into a valid slug.
 */
function sanitizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Generate a kebab-case slug for a prompt.
 * Routes through the configured provider (settings.slugProvider).
 */
export const generateSlug = async (prompt: string): Promise<string> => {
  if (!prompt) return `dmux-${Date.now()}`;

  const provider = await resolveProvider();
  let raw: string | null = null;

  if (provider === 'openrouter') {
    // OpenRouter first, fall back to local agent
    raw = await callOpenRouter(prompt);
    if (!raw) raw = await callLocalAgent(prompt);
  } else if (provider === 'claude' || provider === 'codex') {
    // Specific local agent
    raw = await callLocalAgent(prompt, provider);
  } else {
    // 'auto' — default agent resolution
    raw = await callLocalAgent(prompt);
  }

  if (raw) {
    const slug = sanitizeSlug(raw);
    if (slug) return slug;
  }

  return `dmux-${Date.now()}`;
};
