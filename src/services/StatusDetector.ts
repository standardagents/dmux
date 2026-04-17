import { EventEmitter } from 'events';
import type { DmuxPane, AgentStatus, OptionChoice, PotentialHarm } from '../types.js';
import { WorkerMessageBus } from './WorkerMessageBus.js';
import { PaneWorkerManager } from './PaneWorkerManager.js';
import { PaneAnalyzer } from './PaneAnalyzer.js';
import type { PaneAnalysis } from './PaneAnalyzer.js';
import type { OutboundMessage } from '../workers/WorkerMessages.js';
import type { CodexTurnStoppedPayload } from '../workers/WorkerMessages.js';
import { StateManager } from '../shared/StateManager.js';
import { LogService } from './LogService.js';
import { getPaneDisplayName } from '../utils/paneTitle.js';

export interface StatusUpdateEvent {
  paneId: string;
  status: AgentStatus;
  previousStatus?: AgentStatus;
  optionsQuestion?: string;
  options?: OptionChoice[];
  potentialHarm?: PotentialHarm;
  summary?: string;
  analyzerError?: string;
}

export interface AttentionNeededEvent {
  paneId: string;
  tmuxPaneId: string;
  status: Extract<AgentStatus, 'idle' | 'waiting'>;
  title: string;
  body: string;
  subtitle?: string;
  fingerprint: string;
}

export interface PaneUserInteractionEvent {
  paneId: string;
}

const LLM_ABORT_REASON_TIMEOUT = 'timeout';
const LLM_ABORT_REASON_SUPERSEDED = 'superseded';

/**
 * High-level service coordinating status detection via workers and LLM
 */
export class StatusDetector extends EventEmitter {
  private workerManager: PaneWorkerManager;
  private messageBus: WorkerMessageBus;
  private paneAnalyzer: PaneAnalyzer;
  private paneStatuses = new Map<string, AgentStatus>();
  private llmRequests = new Map<string, AbortController>();
  private paneIdMap = new Map<string, string>(); // dmux pane ID -> tmux pane ID
  private isShuttingDown = false;

  constructor() {
    super();
    this.messageBus = new WorkerMessageBus();
    this.workerManager = new PaneWorkerManager(this.messageBus);
    this.paneAnalyzer = new PaneAnalyzer();

    this.setupMessageHandlers();
  }

  /**
   * Set up handlers for worker messages
   */
  private setupMessageHandlers(): void {
    // Handle status changes from workers
    this.messageBus.subscribe('status-change', async (paneId, message) => {
      await this.handleStatusChange(paneId, message);
    });

    // Handle analysis requests from workers
    this.messageBus.subscribe('analysis-needed', async (paneId, message) => {
      await this.handleAnalysisRequest(paneId, message);
    });

    this.messageBus.subscribe('codex-turn-stopped', async (paneId, message) => {
      await this.handleCodexTurnStopped(paneId, message);
    });

    // Handle worker errors (silently - don't log to console)
    this.messageBus.subscribe('error', (paneId, message) => {
      // Errors are internal - emit as events but don't log to console
      this.emit('worker-error', { paneId, error: message.payload });
    });

    // Handle pane removal (when pane no longer exists in tmux)
    this.messageBus.subscribe('pane-removed', (paneId, message) => {
      this.emit('pane-removed', { paneId, reason: message.payload?.reason });
    });

    // Handle worker ready events
    this.messageBus.subscribe('ready', (paneId) => {
      // Worker ready, no action needed
    });

    this.messageBus.subscribe('user-interaction', (paneId) => {
      this.handleUserInteraction(paneId);
    });
  }

  /**
   * Start monitoring a set of panes
   */
  async monitorPanes(panes: DmuxPane[]): Promise<void> {
    if (this.isShuttingDown) return;

    // Update pane ID mappings
    panes.forEach(pane => {
      if (pane.id && pane.paneId) {
        this.paneIdMap.set(pane.id, pane.paneId);
      }
    });

    // Update workers based on current panes
    await this.workerManager.updateWorkers(panes);
  }

  /**
   * Handle status change from worker
   */
  private async handleStatusChange(
    paneId: string,
    message: OutboundMessage
  ): Promise<void> {
    const { status, previousStatus } = message.payload || {};

    if (!status) return;

    // Update local cache
    const oldStatus = this.paneStatuses.get(paneId);
    this.paneStatuses.set(paneId, status);

    // Cancel any stale LLM request when live activity resumes or the pane
    // leaves the analyzing state before the request completes.
    if (oldStatus === 'analyzing' && status !== 'analyzing') {
      this.cancelLLMRequest(paneId, LLM_ABORT_REASON_SUPERSEDED);
    }

    // Emit event for UI updates
    const updateEvent: StatusUpdateEvent = {
      paneId,
      status,
      previousStatus: oldStatus
    };

    // Clear analyzerError when transitioning to working status
    if (status === 'working') {
      updateEvent.analyzerError = '';
    }

    this.emit('status-updated', updateEvent);
  }

  private async handleCodexTurnStopped(
    paneId: string,
    message: OutboundMessage
  ): Promise<void> {
    const payload = (message.payload || {}) as CodexTurnStoppedPayload;
    const captureSnapshot = payload.captureSnapshot || '';

    this.cancelLLMRequest(paneId, LLM_ABORT_REASON_SUPERSEDED);

    const tmuxPaneId = await this.getTmuxPaneId(paneId);
    if (!tmuxPaneId) {
      return;
    }

    const previousStatus = this.paneStatuses.get(paneId);
    const finalStatus: AgentStatus = 'idle';
    this.paneStatuses.set(paneId, finalStatus);

    let summaryDetails: Pick<PaneAnalysis, 'summary' | 'attentionTitle' | 'attentionBody'> = {};
    try {
      const pane = StateManager.getInstance().getPaneById(paneId);
      summaryDetails = await this.paneAnalyzer.extractSummary(
        payload.lastAssistantMessage || captureSnapshot,
        {
          paneName: pane ? getPaneDisplayName(pane) : paneId,
          panePrompt: pane?.prompt,
          agentLabel: pane?.agent,
        }
      );
    } catch (error) {
      LogService.getInstance().debug(
        `Codex hook summary extraction failed for pane ${paneId}: ${error instanceof Error ? error.message : String(error)}`,
        'statusDetector',
        paneId
      );
    }

    const analysis: PaneAnalysis = {
      state: 'open_prompt',
      summary: summaryDetails.summary,
      attentionTitle: summaryDetails.attentionTitle,
      attentionBody: summaryDetails.attentionBody,
    };

    this.emit('status-updated', {
      paneId,
      status: finalStatus,
      previousStatus,
      summary: analysis.summary,
      analyzerError: '',
    } satisfies StatusUpdateEvent);

    const attentionEvent = this.buildAttentionEvent(paneId, tmuxPaneId, finalStatus, analysis);
    if (attentionEvent) {
      this.emit('attention-needed', attentionEvent);
    }
  }

  /**
   * Handle analysis request from worker
   */
  private async handleAnalysisRequest(
    paneId: string,
    message: OutboundMessage
  ): Promise<void> {
    const { captureSnapshot, reason } = message.payload || {};

    if (!captureSnapshot) return;

    // Cancel any existing request for this pane
    this.cancelLLMRequest(paneId, LLM_ABORT_REASON_SUPERSEDED);

    // Set status to analyzing
    this.paneStatuses.set(paneId, 'analyzing');
    this.emit('status-updated', {
      paneId,
      status: 'analyzing'
    } as StatusUpdateEvent);

    try {
      // Create abort controller for this request with 10 second timeout
      const controller = new AbortController();
      this.llmRequests.set(paneId, controller);

      // Set a timeout to abort if LLM takes too long
      const timeoutId = setTimeout(() => {
        controller.abort(LLM_ABORT_REASON_TIMEOUT);
      }, 10000); // 10 second timeout

      try {
        // Get the tmux pane ID (we need to track this better)
        const tmuxPaneId = await this.getTmuxPaneId(paneId);
        if (!tmuxPaneId) {
          throw new Error(`No tmux pane ID found for ${paneId}`);
        }

        // Run LLM analysis with abort signal (pass dmux pane ID for friendly logging)
        const analysis = await this.paneAnalyzer.analyzePane(
          tmuxPaneId,
          controller.signal,
          paneId,
          captureSnapshot
        );

        // Clear the timeout since analysis completed
        clearTimeout(timeoutId);

        // Check if request was cancelled
        if (controller.signal.aborted) {
          return;
        }

        // Determine final status based on analysis
        const finalStatus: AgentStatus =
          analysis.state === 'option_dialog' ? 'waiting' : 'idle';

        // If we detected an option dialog, add a 2-second delay before allowing
        // the next state detection. This prevents detecting an incomplete state
        // after the user selects an option.
        const delayBeforeNextCheck = analysis.state === 'option_dialog' ? 2000 : 0;

        // Update status
        this.paneStatuses.set(paneId, finalStatus);

        // Check if autopilot should handle this automatically
        await this.handleAutopilot(paneId, analysis, finalStatus);

        // Notify worker of analysis result (fire and forget)
        this.workerManager.notifyWorker(paneId, {
          type: 'analyze-complete',
          timestamp: Date.now(),
          payload: {
            status: finalStatus,
            analysis,
            delayBeforeNextCheck
          }
        });

        // Emit event for UI with analysis data
        const statusEvent: StatusUpdateEvent = {
          paneId,
          status: finalStatus,
          previousStatus: 'analyzing',
          optionsQuestion: analysis.question,
          options: analysis.options,
          potentialHarm: analysis.potentialHarm,
          summary: analysis.summary
        };
        this.emit('status-updated', statusEvent);

        const attentionEvent = this.buildAttentionEvent(paneId, tmuxPaneId, finalStatus, analysis);
        if (attentionEvent) {
          this.emit('attention-needed', attentionEvent);
        }
      } catch (error: any) {
        // Clear the timeout on error
        clearTimeout(timeoutId);

        if (controller.signal.aborted || error.name === 'AbortError') {
          const abortReason = controller.signal.reason;
          if (abortReason !== LLM_ABORT_REASON_TIMEOUT) {
            return;
          }

          // Request was aborted due to timeout
          LogService.getInstance().warn(`LLM analysis timeout for pane ${paneId} after 10 seconds`, 'statusDetector', paneId);

          this.paneStatuses.set(paneId, 'idle');

          // Notify worker that analysis is complete (defaulting to idle)
          this.workerManager.notifyWorker(paneId, {
            type: 'analyze-complete',
            timestamp: Date.now(),
            payload: {
              status: 'idle',
              analysis: { state: 'open_prompt' },
              delayBeforeNextCheck: 0
            }
          });

          this.emit('status-updated', {
            paneId,
            status: 'idle',
            previousStatus: 'analyzing',
            analyzerError: 'Analysis timeout (10s limit)'
          } as StatusUpdateEvent);
          return;
        }

        throw error; // Re-throw other errors to outer catch
      }
    } catch (error: any) {
      LogService.getInstance().error(`LLM analysis error for pane ${paneId}: ${error.message || error}`, 'statusDetector', paneId, error instanceof Error ? error : undefined);

      // Extract detailed error message
      let errorMessage = 'Analysis failed';

      if (error.message) {
        // Clean up common API error patterns
        if (error.message.includes('API error')) {
          // Extract model name and status from API errors
          const match = error.message.match(/API error \(([^)]+)\): (\d+)/);
          if (match) {
            const [, model, status] = match;
            // Provide helpful messages for common status codes
            if (status === '401') {
              errorMessage = `API auth failed - check OPENROUTER_API_KEY`;
            } else if (status === '402') {
              errorMessage = `Insufficient credits - add credits to OpenRouter account`;
            } else if (status === '429') {
              errorMessage = `Rate limited - wait before retrying`;
            } else if (status === '503') {
              errorMessage = `API unavailable (${model})`;
            } else {
              errorMessage = `API error: ${status} (${model})`;
            }
          } else {
            errorMessage = error.message;
          }
        } else if (error.message.includes('API key')) {
          errorMessage = 'Set OPENROUTER_API_KEY env var';
        } else if (error.message.includes('All models')) {
          errorMessage = 'All models failed - check API key & credits';
        } else if (error.message.includes('fetch')) {
          errorMessage = 'Network error - check connection';
        } else {
          errorMessage = error.message;
        }
      }

      // Default to idle on error
      this.paneStatuses.set(paneId, 'idle');
      this.emit('status-updated', {
        paneId,
        status: 'idle',
        previousStatus: 'analyzing',
        analyzerError: errorMessage
      } as StatusUpdateEvent);
    } finally {
      this.llmRequests.delete(paneId);
    }
  }

  /**
   * Cancel LLM request for a pane
   */
  private cancelLLMRequest(
    paneId: string,
    reason: string = LLM_ABORT_REASON_SUPERSEDED
  ): void {
    const controller = this.llmRequests.get(paneId);
    if (controller) {
      controller.abort(reason);
      this.llmRequests.delete(paneId);
    }
  }

  private handleUserInteraction(paneId: string): void {
    this.cancelLLMRequest(paneId, LLM_ABORT_REASON_SUPERSEDED);
    this.emit('pane-user-interaction', {
      paneId,
    } satisfies PaneUserInteractionEvent);
  }

  /**
   * Handle autopilot: automatically accept options when enabled and no risk
   */
  private async handleAutopilot(
    paneId: string,
    analysis: PaneAnalysis,
    finalStatus: AgentStatus
  ): Promise<void> {
    const logService = LogService.getInstance();

    // Get pane data early for friendly naming in logs
    const stateManager = StateManager.getInstance();
    const pane = stateManager.getPaneById(paneId);
    const paneName = pane ? getPaneDisplayName(pane) : paneId;

    // Log entry into autopilot handler
    logService.debug(`Autopilot: Evaluating "${paneName}" (status: ${finalStatus}, state: ${analysis.state})`, 'autopilot', paneId);

    // Only proceed if status is 'waiting' (option dialog detected)
    if (finalStatus !== 'waiting') {
      logService.debug(`Autopilot: Not applicable for "${paneName}" - agent is ${finalStatus}, no decision needed`, 'autopilot', paneId);
      return;
    }

    if (!pane) {
      logService.debug(`Autopilot: Pane ${paneId} not found in state manager`, 'autopilot', paneId);
      return;
    }

    if (!pane.autopilot) {
      logService.debug(`Autopilot: "${paneName}" has autopilot disabled`, 'autopilot', paneId);
      return;
    }

    logService.debug(`Autopilot: "${paneName}" has autopilot enabled - checking analysis results`, 'autopilot', paneId);

    // Check if there's a risk - don't auto-accept risky options
    if (analysis.potentialHarm?.hasRisk) {
      logService.info(
        `Autopilot: Refusing to auto-accept for "${paneName}" - risk detected: ${analysis.potentialHarm.description || 'unknown risk'}`,
        'autopilot',
        paneId
      );
      return;
    }

    logService.debug(`Autopilot: No risk detected for "${paneName}"`, 'autopilot', paneId);

    // Check if we have options
    if (!analysis.options || analysis.options.length === 0) {
      logService.debug(`Autopilot: No options available for "${paneName}"`, 'autopilot', paneId);
      return;
    }

    logService.debug(`Autopilot: Found ${analysis.options.length} options for "${paneName}": ${JSON.stringify(analysis.options.map(o => o.action))}`, 'autopilot', paneId);

    // Get the first option (typically the "accept" or "continue" option)
    const firstOption = analysis.options[0];
    if (!firstOption.keys || firstOption.keys.length === 0) {
      logService.debug(`Autopilot: First option has no keys for "${paneName}"`, 'autopilot', paneId);
      return;
    }

    // Send the first key of the first option
    const keyToSend = firstOption.keys[0];
    logService.info(
      `Autopilot: Auto-accepting option for "${paneName}": "${firstOption.action}" (key: ${keyToSend})`,
      'autopilot',
      paneId
    );

    try {
      // Send the key through the worker manager
      await this.sendKeysToPane(paneId, keyToSend);
      logService.debug(`Autopilot: Successfully sent key '${keyToSend}' to "${paneName}"`, 'autopilot', paneId);
    } catch (error) {
      logService.error(
        `Autopilot: Failed to send keys for "${paneName}": ${error}`,
        'autopilot',
        paneId,
        error instanceof Error ? error : undefined
      );
    }
  }

  private buildAttentionEvent(
    paneId: string,
    tmuxPaneId: string,
    status: AgentStatus,
    analysis: PaneAnalysis
  ): AttentionNeededEvent | null {
    if (status !== 'idle' && status !== 'waiting') {
      return null;
    }

    const pane = StateManager.getInstance().getPaneById(paneId);
    const subtitle = pane ? getPaneDisplayName(pane) : undefined;

    const title = analysis.attentionTitle
      || (status === 'waiting'
        ? 'Decision needed'
        : 'Ready for the next prompt');

    const body = analysis.attentionBody
      || (status === 'waiting'
        ? `${analysis.question || 'The agent is waiting for your input.'} Open the pane and choose how to continue.`
        : `${analysis.summary || 'The agent finished its current step.'} Open the pane and continue the work.`);

    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle || !normalizedBody) {
      return null;
    }

    return {
      paneId,
      tmuxPaneId,
      status,
      title: normalizedTitle,
      body: normalizedBody,
      subtitle,
      fingerprint: `${status}:${normalizedTitle}:${normalizedBody}`,
    };
  }

  /**
   * Get tmux pane ID for a dmux pane
   */
  private async getTmuxPaneId(paneId: string): Promise<string | null> {
    return this.paneIdMap.get(paneId) || null;
  }

  /**
   * Get current status for a pane
   */
  getStatus(paneId: string): AgentStatus | undefined {
    return this.paneStatuses.get(paneId);
  }

  /**
   * Get all statuses
   */
  getAllStatuses(): Map<string, AgentStatus> {
    return new Map(this.paneStatuses);
  }

  /**
   * Send keys to a pane (future feature)
   */
  async sendKeysToPane(paneId: string, keys: string): Promise<void> {
    return this.workerManager.sendToWorker(paneId, {
      type: 'send-keys',
      timestamp: Date.now(),
      payload: { keys }
    }).then(() => {});
  }

  /**
   * Resize a pane (future feature)
   */
  async resizePane(
    paneId: string,
    width?: number,
    height?: number
  ): Promise<void> {
    return this.workerManager.sendToWorker(paneId, {
      type: 'resize',
      timestamp: Date.now(),
      payload: { width, height }
    }).then(() => {});
  }

  /**
   * Get statistics
   */
  getStats(): {
    workerStats: ReturnType<PaneWorkerManager['getStats']>;
    messageBusStats: ReturnType<WorkerMessageBus['getStats']>;
    statusCounts: Record<AgentStatus, number>;
    llmRequestsInFlight: number;
  } {
    const statusCounts: Record<AgentStatus, number> = {
      idle: 0,
      analyzing: 0,
      waiting: 0,
      working: 0
    };

    this.paneStatuses.forEach(status => {
      statusCounts[status]++;
    });

    return {
      workerStats: this.workerManager.getStats(),
      messageBusStats: this.messageBus.getStats(),
      statusCounts,
      llmRequestsInFlight: this.llmRequests.size
    };
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Cancel all LLM requests
    this.llmRequests.forEach(controller => controller.abort());
    this.llmRequests.clear();

    // Shutdown workers
    await this.workerManager.shutdown();

    // Clean up message bus
    this.messageBus.destroy();

    // Clear state
    this.paneStatuses.clear();
    this.paneIdMap.clear();

    // Remove all listeners
    this.removeAllListeners();
  }
}

// Export singleton instance
let instance: StatusDetector | null = null;

export function getStatusDetector(): StatusDetector {
  if (!instance) {
    instance = new StatusDetector();
  }
  return instance;
}

export function resetStatusDetector(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
