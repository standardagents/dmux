import { createHash } from 'crypto';
import { capturePaneContent } from '../utils/paneCapture.js';
import { LogService } from './LogService.js';
import { getPaneDisplayName } from '../utils/paneTitle.js';
import { createAnalysisProvider, type AnalysisProvider } from '../providers/AnalysisProvider.js';

// State types for agent status
export type PaneState = 'option_dialog' | 'open_prompt' | 'in_progress';

// Interface for the structured response from the LLM
export interface PaneAnalysis {
  state: PaneState;
  question?: string;
  options?: Array<{
    action: string;
    keys: string[];
    description?: string;
  }>;
  potentialHarm?: {
    hasRisk: boolean;
    description?: string;
  };
  summary?: string; // Brief summary when state is 'open_prompt' (idle)
  attentionTitle?: string;
  attentionBody?: string;
}

interface CacheEntry {
  result: PaneAnalysis;
  timestamp: number;
}

interface PaneContext {
  paneName: string;
  panePrompt?: string;
  agentLabel?: string;
}

const ANALYZER_CONTEXT_LINE_LIMIT = 50;

function trimSurroundingEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }

  return lines.slice(start, end);
}

export function normalizePaneContentForAnalysis(
  content: string,
  maxLines: number = ANALYZER_CONTEXT_LINE_LIMIT
): string {
  if (!content) {
    return '';
  }

  const trimmedLines = trimSurroundingEmptyLines(content.split('\n'));
  if (trimmedLines.length === 0) {
    return '';
  }

  return trimSurroundingEmptyLines(trimmedLines.slice(-maxLines)).join('\n');
}

export interface AdherenceResult {
  onTrack: boolean;
  confidence: number;
  reason: string;
}

export function buildAdherencePrompt(
  paneContent: string,
  taskContext?: string,
  paneName?: string
): string {
  const task = taskContext
    || (paneName ? `Task inferred from branch: "${paneName}"` : 'Unknown task');
  return [
    `INTENDED TASK: ${task}`,
    '',
    'CURRENT TERMINAL OUTPUT (last 30 lines):',
    paneContent,
    '',
    'Is this agent on the intended task? JSON: {"onTrack": bool, "confidence": 0.0-1.0, "reason": "brief"}',
  ].join('\n');
}

export function parseAdherenceResponse(response: string): AdherenceResult | null {
  try {
    const data = JSON.parse(response);
    if (typeof data.onTrack !== 'boolean' || typeof data.confidence !== 'number' || typeof data.reason !== 'string') {
      return null;
    }
    return { onTrack: data.onTrack, confidence: Math.max(0, Math.min(1, data.confidence)), reason: data.reason };
  } catch { return null; }
}

export class PaneAnalyzer {
  private provider: AnalysisProvider;

  // Content-hash based cache to avoid repeated API calls for identical content
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = 5000; // 5 seconds TTL
  private readonly MAX_CACHE_SIZE = 100; // Prevent unbounded growth

  // Request deduplication - prevent multiple concurrent requests for same pane
  private pendingRequests = new Map<string, Promise<PaneAnalysis>>();

  constructor() {
    const backend = (process.env.DMUX_ANALYSIS_BACKEND || 'auto') as any;
    this.provider = createAnalysisProvider(backend, {
      openRouterKey: process.env.OPENROUTER_API_KEY || '',
    });
  }

  /**
   * Hash content for cache key
   */
  private hashContent(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  /**
   * Get cached result if still valid
   */
  private getCached(hash: string): PaneAnalysis | null {
    const entry = this.cache.get(hash);
    if (entry && Date.now() - entry.timestamp < this.CACHE_TTL) {
      return entry.result;
    }
    // Clean up expired entry
    if (entry) {
      this.cache.delete(hash);
    }
    return null;
  }

  /**
   * Store result in cache with LRU eviction
   */
  private setCache(hash: string, result: PaneAnalysis): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(hash, { result, timestamp: Date.now() });
  }

  /**
   * Clear all cache entries (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }



  /**
   * Stage 1: Determines the state of the pane
   * @param content - Captured pane content
   * @param signal - Optional abort signal
   * @param paneName - Optional friendly pane name for logging
   */
  async determineState(content: string, signal?: AbortSignal, paneName?: string): Promise<PaneState> {
    const logService = LogService.getInstance();

    if (!this.provider.isAvailable()) {
      // Provider not available
      logService.debug(`PaneAnalyzer: Provider not available, defaulting to in_progress state${paneName ? ` for "${paneName}"` : ''}`, 'paneAnalyzer');
      return 'in_progress';
    }

    const systemPrompt = `You are analyzing terminal output to determine its current state.
IMPORTANT: Focus primarily on the LAST 10 LINES of the output, as that's where the current state is shown.

Return a JSON object with a "state" field containing exactly one of these three values:
- "option_dialog": ONLY when specific options/choices are clearly presented
- "in_progress": When there are progress indicators showing active work
- "open_prompt": DEFAULT state - use this unless you're certain it's one of the above

OPTION DIALOG - Must have clear choices presented:
- "Continue? [y/n]"
- "Select: 1) Create 2) Edit 3) Cancel"
- "[A]ccept, [R]eject, [E]dit"
- Menu with numbered/lettered options
- Clear list of specific keys/choices to select

IN PROGRESS - Look for these in the BOTTOM 10 LINES:
- KEY INDICATOR: "(esc to interrupt)" or "esc to cancel" = ALWAYS in_progress
- Progress symbols with ANY action word: ✶ ⏺ ✽ ⏳ 🔄 followed by any word ending in "ing..."
- Common progress words: "Working..." "Loading..." "Processing..." "Running..." "Building..."
- Claude Code's creative words: "Pondering..." "Crunching..." "Flibbergibberating..." etc.
- ANY word ending in "ing..." with progress symbols
- Active progress bars or percentages
- The phrase "esc to interrupt" anywhere = definitely in_progress

OPEN PROMPT - The DEFAULT state:
- Empty prompts: "> "
- Questions waiting for input
- Any prompt line without specific options
- Static UI elements like "⏵⏵ accept edits on" (without "esc to interrupt")
- When there's no clear progress or options

CRITICAL:
1. Check the BOTTOM 10 lines first - that's where the current state appears
2. If you see "(esc to interrupt)" ANYWHERE = it's in_progress
3. When uncertain, default to "open_prompt"`;

    try {
      logService.debug(`PaneAnalyzer: Requesting state determination${paneName ? ` for "${paneName}"` : ''}`, 'paneAnalyzer');

      const content_response = await this.provider.analyze(
        { system: systemPrompt, user: `Analyze this terminal output and return a JSON object with the state:\n\n${content}`, maxTokens: 20 },
        signal
      );

      const result = JSON.parse(content_response || '{}');
      logService.debug(`PaneAnalyzer: LLM response for state determination${paneName ? ` ("${paneName}")` : ''}: ${JSON.stringify(result)}`, 'paneAnalyzer');

      // Validate the state
      const state = result.state;
      if (state === 'option_dialog' || state === 'open_prompt' || state === 'in_progress') {
        logService.debug(`PaneAnalyzer: Determined state${paneName ? ` for "${paneName}"` : ''}: ${state}`, 'paneAnalyzer');
        return state;
      }

      logService.debug(`PaneAnalyzer: Invalid state received${paneName ? ` for "${paneName}"` : ''} (${state}), defaulting to in_progress`, 'paneAnalyzer');
      return 'in_progress';
    } catch (error) {
      logService.error(`PaneAnalyzer: Failed to determine state${paneName ? ` for "${paneName}"` : ''}: ${error}`, 'paneAnalyzer', undefined, error instanceof Error ? error : undefined);
      // Failed to determine state - throw error to be handled by caller
      throw error;
    }
  }

  /**
   * Stage 2: Extract option details if state is option_dialog
   * @param content - Captured pane content
   * @param signal - Optional abort signal
   * @param paneName - Optional friendly pane name for logging
   */
  async extractOptions(
    content: string,
    context: PaneContext,
    signal?: AbortSignal
  ): Promise<Omit<PaneAnalysis, 'state'>> {
    const logService = LogService.getInstance();
    const paneName = context.paneName;

    if (!this.provider.isAvailable()) {
      logService.debug(`PaneAnalyzer: Provider not available, cannot extract options${paneName ? ` for "${paneName}"` : ''}`, 'paneAnalyzer');
      return {};
    }

    const systemPrompt = `You are analyzing an option dialog in a terminal.
Extract the following and return as JSON:
1. The question being asked
2. Each available option with:
   - The action/choice description
   - The exact keys to press (could be letters, numbers, arrow keys + enter, etc.)
   - Any additional context

Return a JSON object with:
- question: The question or prompt text
- options: Array of {action, keys, description}
- potential_harm: {has_risk, description} if there's risk of harm
- attention_title: 3-8 words describing what needs review
- attention_body: one sentence, under 140 characters, that states what finished and nudges the user to continue

EXAMPLES:
Input: "Delete all files? [y/n]"
Output: {
  "question": "Delete all files?",
  "options": [
    {"action": "Yes", "keys": ["y"]},
    {"action": "No", "keys": ["n"]}
  ],
  "attention_title": "Confirm file deletion",
  "attention_body": "The agent is waiting on a yes or no. Open the pane and decide how to proceed.",
  "potential_harm": {"has_risk": true, "description": "Will delete all files"}
}

Input: "Select option:\n1. Create file\n2. Edit file\n3. Cancel"
Output: {
  "question": "Select option:",
  "options": [
    {"action": "Create file", "keys": ["1"]},
    {"action": "Edit file", "keys": ["2"]},
    {"action": "Cancel", "keys": ["3"]}
  ],
  "attention_title": "Choose the next step",
  "attention_body": "The agent prepared the options and needs your choice to keep going."
}

Input: "[A]ccept edits, [R]eject, [E]dit manually"
Output: {
  "question": "Choose action for edits",
  "options": [
    {"action": "Accept edits", "keys": ["a", "A"]},
    {"action": "Reject", "keys": ["r", "R"]},
    {"action": "Edit manually", "keys": ["e", "E"]}
  ],
  "attention_title": "Review the proposed edits",
  "attention_body": "The agent finished this pass and is waiting for your decision so it can continue."
}`;

    try {
      logService.debug(`PaneAnalyzer: Requesting options extraction${paneName ? ` for "${paneName}"` : ''}`, 'paneAnalyzer');

      const content_response = await this.provider.analyze(
        { system: systemPrompt, user: `Pane: ${context.paneName}
Agent: ${context.agentLabel || 'unknown'}
Original task: ${context.panePrompt || 'unknown'}

Extract the option details from this dialog and return as JSON:

${content}`, maxTokens: 360 },
        signal
      );

      const result = JSON.parse(content_response || '{}');
      logService.debug(`PaneAnalyzer: LLM response for options extraction${paneName ? ` ("${paneName}")` : ''}: ${JSON.stringify(result)}`, 'paneAnalyzer');

      const parsedOptions = {
        question: result.question,
        options: result.options?.map((opt: any) => ({
          action: opt.action,
          keys: Array.isArray(opt.keys) ? opt.keys : [opt.keys],
          description: opt.description
        })),
        attentionTitle: result.attention_title,
        attentionBody: result.attention_body,
        potentialHarm: result.potential_harm ? {
          hasRisk: result.potential_harm.has_risk,
          description: result.potential_harm.description
        } : undefined
      };

      logService.debug(
        `PaneAnalyzer: Extracted ${parsedOptions.options?.length || 0} options${paneName ? ` for "${paneName}"` : ''}` +
        (parsedOptions.potentialHarm?.hasRisk ? ` (RISK: ${parsedOptions.potentialHarm.description})` : ''),
        'paneAnalyzer'
      );

      return parsedOptions;
    } catch (error) {
      logService.error(`PaneAnalyzer: Failed to extract options${paneName ? ` for "${paneName}"` : ''}: ${error}`, 'paneAnalyzer', undefined, error instanceof Error ? error : undefined);
      // Failed to extract options - throw error to be handled by caller
      throw error;
    }
  }

  /**
   * Stage 3: Extract summary when state is open_prompt (idle)
   */
  async extractSummary(
    content: string,
    context: PaneContext,
    signal?: AbortSignal
  ): Promise<Pick<PaneAnalysis, 'summary' | 'attentionTitle' | 'attentionBody'>> {
    if (!this.provider.isAvailable()) {
      return {};
    }

    const systemPrompt = `You are analyzing terminal output from an AI coding agent.
The agent is now idle and waiting for the next prompt.

Your task:
1. Provide a short summary of what the agent communicated before going idle.
2. Write a concise macOS notification title.
3. Write a short notification body that both explains the completed step and nudges the user to continue.

Focus on:
- What the agent just finished doing or said
- Any results, conclusions, or feedback provided
- Keep it concise
- Use past tense ("completed", "fixed", "created", etc.)
- Notification title should be 3-8 words
- Notification body should be one sentence, under 140 characters

Return a JSON object with:
- summary
- attention_title
- attention_body

Examples:
- "Completed refactoring the authentication module and fixed TypeScript errors."
- "Created the new user dashboard component with responsive design."
- "Build succeeded with no errors. All tests passed."
- "Unable to find the specified file. Waiting for clarification."

If there's no meaningful content or the output is unclear, return empty strings.`;

    try {
      const content_response = await this.provider.analyze(
        { system: systemPrompt, user: `Pane: ${context.paneName}
Agent: ${context.agentLabel || 'unknown'}
Original task: ${context.panePrompt || 'unknown'}

Extract the summary and notification copy from this terminal output:

${content}`, maxTokens: 180 },
        signal
      );

      const result = JSON.parse(content_response || '{}');

      return {
        summary: result.summary || undefined,
        attentionTitle: result.attention_title || undefined,
        attentionBody: result.attention_body || undefined,
      };
    } catch (error) {
      return {};
    }
  }

  /**
   * Internal analysis implementation (no caching/deduplication)
   */
  private async doAnalyzePane(
    tmuxPaneId: string,
    content: string,
    context: PaneContext,
    dmuxPaneId: string | undefined,
    signal?: AbortSignal
  ): Promise<PaneAnalysis> {
    const logService = LogService.getInstance();
    const paneName = context.paneName;

    try {
      // Stage 1: Determine the state
      const state = await this.determineState(content, signal, paneName);

      // If it's an option dialog, extract option details
      if (state === 'option_dialog') {
        logService.debug(`PaneAnalyzer: Detected option_dialog for "${paneName}", extracting options...`, 'paneAnalyzer', dmuxPaneId);
        const optionDetails = await this.extractOptions(content, context, signal);
        return {
          state,
          ...optionDetails
        };
      }

      // If it's open_prompt (idle), extract summary
      if (state === 'open_prompt') {
        logService.debug(`PaneAnalyzer: Detected open_prompt for "${paneName}", extracting summary...`, 'paneAnalyzer', dmuxPaneId);
        const summaryDetails = await this.extractSummary(content, context, signal);
        return {
          state,
          ...summaryDetails
        };
      }

      // Otherwise just return the state (in_progress)
      return { state };
    } catch (error) {
      logService.error(`PaneAnalyzer: Analysis failed for "${paneName}": ${error}`, 'paneAnalyzer', dmuxPaneId, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Main analysis function that captures and analyzes a pane
   * Includes caching and request deduplication for performance.
   *
   * @param tmuxPaneId - The tmux pane ID (e.g., "%38")
   * @param signal - Optional abort signal
   * @param dmuxPaneId - Optional dmux pane ID for friendly logging (e.g., "dmux-123")
   */
  async analyzePane(
    tmuxPaneId: string,
    signal?: AbortSignal,
    dmuxPaneId?: string,
    capturedSnapshot?: string
  ): Promise<PaneAnalysis> {
    const logService = LogService.getInstance();

    // For logging, try to get friendly name from StateManager
    let paneName = tmuxPaneId;
    let panePrompt: string | undefined;
    let agentLabel: string | undefined;
    if (dmuxPaneId) {
      try {
        // Import dynamically to avoid circular dependency
        const { StateManager } = await import('../shared/StateManager.js');
        const pane = StateManager.getInstance().getPaneById(dmuxPaneId);
        paneName = pane ? getPaneDisplayName(pane) : dmuxPaneId;
        panePrompt = pane?.prompt;
        agentLabel = pane?.agent;
      } catch {
        paneName = dmuxPaneId;
      }
    }

    logService.debug(`PaneAnalyzer: Starting analysis for "${paneName}"`, 'paneAnalyzer', dmuxPaneId);

    // Normalize the analyzer input to the last 50 trimmed lines so every LLM stage
    // sees the same bounded pane snapshot.
    const analysisSource = typeof capturedSnapshot === 'string'
      ? capturedSnapshot
      : capturePaneContent(tmuxPaneId, ANALYZER_CONTEXT_LINE_LIMIT);
    const content = normalizePaneContentForAnalysis(
      analysisSource,
      ANALYZER_CONTEXT_LINE_LIMIT
    );

    if (!content) {
      logService.debug(`PaneAnalyzer: No content captured for "${paneName}", defaulting to in_progress`, 'paneAnalyzer', dmuxPaneId);
      return { state: 'in_progress' };
    }

    // Check cache first
    const contentHash = this.hashContent(content);
    const cached = this.getCached(contentHash);
    if (cached) {
      logService.debug(`PaneAnalyzer: Cache hit for "${paneName}"`, 'paneAnalyzer', dmuxPaneId);
      return cached;
    }

    // Check for pending request (deduplication)
    const pendingKey = `${tmuxPaneId}:${contentHash}`;
    if (this.pendingRequests.has(pendingKey)) {
      logService.debug(`PaneAnalyzer: Deduplicating request for "${paneName}"`, 'paneAnalyzer', dmuxPaneId);
      return this.pendingRequests.get(pendingKey)!;
    }

    // Start new analysis
    const analysisPromise = this.doAnalyzePane(
      tmuxPaneId,
      content,
      {
        paneName,
        panePrompt,
        agentLabel,
      },
      dmuxPaneId,
      signal
    )
      .then(result => {
        // Cache successful result
        this.setCache(contentHash, result);
        logService.debug(`PaneAnalyzer: Analysis complete for "${paneName}": ${result.state}`, 'paneAnalyzer', dmuxPaneId);
        return result;
      })
      .finally(() => {
        // Clean up pending request
        this.pendingRequests.delete(pendingKey);
      });

    this.pendingRequests.set(pendingKey, analysisPromise);

    try {
      return await analysisPromise;
    } catch (error) {
      // All models failed or other error occurred
      // Return open_prompt as fallback (idle state) and let error be handled by caller
      throw error;
    }
  }
}
