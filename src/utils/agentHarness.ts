/**
 * Agent Harness
 *
 * Unified interface for calling AI agents (claude, opencode, codex) from the CLI.
 * Replaces all direct OpenRouter API calls and per-file callClaudeCode helpers.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAvailableAgents } from './agentDetection.js';
import { LogService } from '../services/LogService.js';

interface CallAgentOptions {
  agent?: 'claude' | 'opencode' | 'codex';
  timeout?: number; // ms, default 60000
  json?: boolean;   // append JSON instruction + strip fences
  cheap?: boolean;  // use cheapest available model (haiku)
  model?: 'cheap' | 'mid';  // explicit model tier (overrides cheap flag)
}

// Model tier mappings per agent
const MODEL_TIERS: Record<string, Record<string, string>> = {
  claude: {
    cheap: 'haiku',
    mid: 'sonnet',
  },
  opencode: {
    cheap: 'anthropic/claude-haiku-4-5',
    mid: 'anthropic/claude-sonnet-4-5',
  },
};

/**
 * Resolve which agent to use based on: explicit param > defaultAgent setting > first available
 */
export async function resolveAgent(preferredAgent?: 'claude' | 'opencode' | 'codex'): Promise<'claude' | 'opencode' | 'codex' | null> {
  const available = await getAvailableAgents();

  if (preferredAgent) {
    if (available.includes(preferredAgent)) return preferredAgent;
  }

  // Check settings for default agent
  try {
    const { SettingsManager } = await import('./settingsManager.js');
    const settings = new SettingsManager().getSettings();
    if (settings.defaultAgent) {
      const da = settings.defaultAgent as 'claude' | 'opencode' | 'codex';
      if (available.includes(da)) return da;
    }
  } catch {}

  // Fall back to first available
  return available.length > 0 ? available[0] : null;
}

/**
 * Call an AI agent CLI with a prompt and return the response.
 * Returns null on any failure (timeout, agent not found, etc.)
 */
export async function callAgent(prompt: string, options: CallAgentOptions = {}): Promise<string | null> {
  const logger = LogService.getInstance();
  const timeout = options.timeout ?? 60000;

  const agent = await resolveAgent(options.agent);
  if (!agent) {
    logger.debug('callAgent: No agent available', 'agentHarness');
    return null;
  }

  let fullPrompt = prompt;
  if (options.json) {
    fullPrompt += '\n\nRespond with ONLY valid JSON, no explanations or markdown.';
  }

  // Write prompt to a temp file to avoid shell escaping issues
  const tmpFile = path.join(tmpdir(), `dmux-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(tmpFile, fullPrompt, 'utf-8');

  // Build model flag based on tier
  const tier = options.model ?? (options.cheap ? 'cheap' : undefined);
  const modelId = tier && MODEL_TIERS[agent]?.[tier];
  const modelFlag = modelId ? ` --model ${modelId}` : '';

  let command: string;
  if (agent === 'claude') {
    command = `cat "${tmpFile}" | claude --print${modelFlag} 2>/dev/null`;
  } else if (agent === 'opencode') {
    command = `cat "${tmpFile}" | opencode run${modelFlag} 2>/dev/null`;
  } else if (agent === 'codex') {
    command = `cat "${tmpFile}" | codex --quiet 2>/dev/null`;
  } else {
    try { unlinkSync(tmpFile); } catch {}
    return null;
  }

  // Remove CLAUDECODE env var to allow nested claude calls from within Claude Code sessions
  const env = { ...process.env };
  delete env.CLAUDECODE;

  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout,
      env,
    });

    let output = result.trim();
    if (!output) return null;

    // Strip markdown code fences if present
    if (options.json) {
      output = output.replace(/^```(?:json)?\n?/gm, '').replace(/\n?```$/gm, '').trim();
    }

    return output;
  } catch (error) {
    logger.debug(`callAgent: ${agent} failed: ${error instanceof Error ? error.message : error}`, 'agentHarness');
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
