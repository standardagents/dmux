import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import type { DmuxPane } from '../types.js';
import type { WorkerMessageBus } from './WorkerMessageBus.js';
import type {
  InboundMessage,
  OutboundMessage,
  WorkerConfig
} from '../workers/WorkerMessages.js';
import { LogService } from './LogService.js';
import { WORKER_BACKOFF_BASE } from '../constants/timing.js';
import { resolveDistPath } from '../utils/runtimePaths.js';

interface WorkerInfo {
  worker: Worker;
  paneId: string;
  tmuxPaneId: string;
  paneType?: DmuxPane['type'];
  agent?: DmuxPane['agent'];
  startTime: number;
  restartCount: number;
}

export function shouldMonitorPaneForStatusTracking(
  pane: Pick<DmuxPane, 'type' | 'agent'>
): boolean {
  return pane.type !== 'shell' && Boolean(pane.agent);
}

/**
 * Manages lifecycle of pane worker threads
 */
export class PaneWorkerManager {
  private workers = new Map<string, WorkerInfo>();
  private messageBus: WorkerMessageBus;
  private isShuttingDown = false;
  private workerPath: string;

  constructor(messageBus: WorkerMessageBus) {
    this.messageBus = messageBus;
    this.workerPath = resolveDistPath('workers', 'PaneWorker.js');
  }

  /**
   * Create a new worker for a pane
   */
  createWorker(pane: DmuxPane): void {
    // Don't create if already exists or shutting down
    if (this.workers.has(pane.id) || this.isShuttingDown || !shouldMonitorPaneForStatusTracking(pane)) {
      return;
    }

    try {
      const config: WorkerConfig = {
        paneId: pane.id,
        tmuxPaneId: pane.paneId,
        agent: pane.agent,
        worktreePath: pane.worktreePath,
        pollInterval: 1000 // 1 second polling
      };

      const worker = new Worker(this.workerPath, {
        workerData: config
      });

      const workerInfo: WorkerInfo = {
        worker,
        paneId: pane.id,
        tmuxPaneId: pane.paneId,
        paneType: pane.type,
        agent: pane.agent,
        startTime: Date.now(),
        restartCount: 0
      };

      // Handle messages from worker
      worker.on('message', (message: OutboundMessage) => {
        this.handleWorkerMessage(pane.id, message);
      });

      // Handle worker errors
      worker.on('error', (error) => {
        const msg = `Worker ${pane.id} error`;
        console.error(msg, error);
        LogService.getInstance().error(msg, 'PaneWorkerManager', pane.id, error);
        this.handleWorkerError(pane.id, error);
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0 && !this.isShuttingDown) {
          const msg = `Worker ${pane.id} exited with code ${code}`;
          console.error(msg);
          LogService.getInstance().error(msg, 'PaneWorkerManager', pane.id);
          this.handleWorkerExit(pane.id);
        }
      });

      this.workers.set(pane.id, workerInfo);
    } catch (error) {
      const msg = `Failed to create worker for pane ${pane.id}`;
      console.error(msg, error);
      LogService.getInstance().error(msg, 'PaneWorkerManager', pane.id, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Send message to a specific worker
   */
  async sendToWorker(
    paneId: string,
    message: Omit<InboundMessage, 'id'>
  ): Promise<OutboundMessage> {
    const workerInfo = this.workers.get(paneId);
    if (!workerInfo) {
      throw new Error(`No worker found for pane ${paneId}`);
    }

    const messageId = randomUUID();
    const fullMessage: InboundMessage = {
      ...message,
      id: messageId,
      timestamp: Date.now()
    };

    // Set up response promise before sending
    const responsePromise = this.messageBus.waitForResponse(messageId);

    // Send message to worker
    workerInfo.worker.postMessage(fullMessage);

    return responsePromise;
  }

  /**
   * Send notification to a worker without waiting for response
   */
  notifyWorker(
    paneId: string,
    message: Omit<InboundMessage, 'id'>
  ): void {
    const workerInfo = this.workers.get(paneId);
    if (!workerInfo) {
      const msg = `No worker found for pane ${paneId}`;
      console.error(msg);
      LogService.getInstance().warn(msg, 'PaneWorkerManager', paneId);
      return;
    }

    const fullMessage: InboundMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now()
    };

    try {
      workerInfo.worker.postMessage(fullMessage);
    } catch (error) {
      const msg = `Failed to notify worker ${paneId}`;
      console.error(msg, error);
      LogService.getInstance().error(msg, 'PaneWorkerManager', paneId, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Broadcast message to all workers
   */
  broadcastToWorkers(message: Omit<InboundMessage, 'id'>): void {
    this.workers.forEach((workerInfo, paneId) => {
      try {
        const fullMessage: InboundMessage = {
          ...message,
          id: randomUUID(),
          timestamp: Date.now()
        };
        workerInfo.worker.postMessage(fullMessage);
      } catch (error) {
        const msg = `Failed to broadcast to worker ${paneId}`;
        console.error(msg, error);
        LogService.getInstance().error(msg, 'PaneWorkerManager', paneId, error instanceof Error ? error : undefined);
      }
    });
  }

  /**
   * Destroy a specific worker
   */
  async destroyWorker(paneId: string): Promise<void> {
    const workerInfo = this.workers.get(paneId);
    if (!workerInfo) return;

    try {
      // Send shutdown message
      await this.sendToWorker(paneId, {
        type: 'shutdown',
        timestamp: Date.now()
      }).catch(() => {});

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500));

      // Force terminate if still running
      await workerInfo.worker.terminate();
    } catch (error) {
      const msg = `Error destroying worker ${paneId}`;
      console.error(msg, error);
      LogService.getInstance().error(msg, 'PaneWorkerManager', paneId, error instanceof Error ? error : undefined);
    } finally {
      this.workers.delete(paneId);
    }
  }

  /**
   * Update workers based on current panes
   */
  async updateWorkers(panes: DmuxPane[]): Promise<void> {
    const monitoredPanes = panes.filter(shouldMonitorPaneForStatusTracking);
    const currentPaneIds = new Set(monitoredPanes.map(p => p.id));

    // Create workers for new panes
    for (const pane of monitoredPanes) {
      if (!this.workers.has(pane.id)) {
        this.createWorker(pane);
      } else {
        // Check if tmux pane ID changed
        const workerInfo = this.workers.get(pane.id)!;
        if (workerInfo.tmuxPaneId !== pane.paneId) {
          // Pane ID changed, recreate worker
          await this.destroyWorker(pane.id);
          this.createWorker(pane);
        }
      }
    }

    // Destroy workers for removed panes
    const workersToRemove: string[] = [];
    for (const [paneId] of this.workers) {
      if (!currentPaneIds.has(paneId)) {
        workersToRemove.push(paneId);
      }
    }

    await Promise.all(workersToRemove.map(id => this.destroyWorker(id)));
  }

  /**
   * Handle message from worker
   */
  private handleWorkerMessage(paneId: string, message: OutboundMessage): void {
    // Forward to message bus
    this.messageBus.handleWorkerMessage(paneId, message);
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(paneId: string, error: Error): void {
    const workerInfo = this.workers.get(paneId);
    if (!workerInfo) return;

    // Attempt restart if not too many attempts
    if (workerInfo.restartCount < 3) {
      this.restartWorker(paneId);
    } else {
      const msg = `Worker ${paneId} failed too many times, not restarting`;
      console.error(msg);
      LogService.getInstance().error(msg, 'PaneWorkerManager', paneId);
      this.workers.delete(paneId);
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(paneId: string): void {
    if (!this.isShuttingDown) {
      const workerInfo = this.workers.get(paneId);
      if (workerInfo && workerInfo.restartCount < 3) {
        this.restartWorker(paneId);
      } else {
        this.workers.delete(paneId);
      }
    }
  }

  /**
   * Restart a worker
   */
  private async restartWorker(paneId: string): Promise<void> {
    const workerInfo = this.workers.get(paneId);
    if (!workerInfo) return;

    const tmuxPaneId = workerInfo.tmuxPaneId;
    const restartCount = workerInfo.restartCount + 1;

    // Destroy old worker
    this.workers.delete(paneId);
    try {
      await workerInfo.worker.terminate();
    } catch {
      // Intentionally silent - worker may already be dead
    }

    // Wait before restart with exponential backoff
    await new Promise(resolve => setTimeout(resolve, WORKER_BACKOFF_BASE * restartCount));

    // Create new worker with updated restart count
    if (!this.isShuttingDown) {
      this.createWorker({
        id: paneId,
        paneId: tmuxPaneId,
        slug: '',
        prompt: '',
        type: workerInfo.paneType,
        agent: workerInfo.agent,
      } as DmuxPane);

      const newWorkerInfo = this.workers.get(paneId);
      if (newWorkerInfo) {
        newWorkerInfo.restartCount = restartCount;
      }
    }
  }

  /**
   * Get worker statistics
   */
  getStats(): {
    workerCount: number;
    workers: Array<{
      paneId: string;
      uptime: number;
      restartCount: number;
    }>;
  } {
    const workers = Array.from(this.workers.entries()).map(([paneId, info]) => ({
      paneId,
      uptime: Date.now() - info.startTime,
      restartCount: info.restartCount
    }));

    return {
      workerCount: this.workers.size,
      workers
    };
  }

  /**
   * Shutdown all workers
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Send shutdown to all workers
    const shutdownPromises = Array.from(this.workers.keys()).map(paneId =>
      this.destroyWorker(paneId)
    );

    await Promise.all(shutdownPromises);
    this.workers.clear();
  }
}
