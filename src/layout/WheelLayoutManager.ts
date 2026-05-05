export interface WheelConfig {
  rows: number;
  columns: number;
}

export interface WheelGeometry {
  paneWidth: number;
  paneHeight: number;
  columns: number;
  rows: number;
}

export class WheelLayoutManager {
  private config: WheelConfig;
  private slots: (string | null)[];
  private _overflowQueue: string[] = [];
  private splitPanes = new Set<string>();

  constructor(config: WheelConfig) {
    this.config = config;
    this.slots = new Array(config.rows * config.columns).fill(null);
  }

  get capacity(): number { return this.config.rows * this.config.columns; }

  get filledSlots(): number { return this.slots.filter(s => s !== null).length; }

  get overflowQueue(): string[] { return [...this._overflowQueue]; }

  addPane(paneId: string): number {
    const slot = this.slots.indexOf(null);
    if (slot === -1) {
      this._overflowQueue.push(paneId);
      return -1;
    }
    this.slots[slot] = paneId;
    return slot;
  }

  removePane(paneId: string): void {
    if (this.splitPanes.has(paneId)) return;

    const index = this.slots.indexOf(paneId);
    if (index === -1) {
      this._overflowQueue = this._overflowQueue.filter(id => id !== paneId);
      return;
    }

    this.slots.splice(index, 1);
    this.slots.push(null);

    if (this._overflowQueue.length > 0) {
      const next = this._overflowQueue.shift()!;
      const empty = this.slots.indexOf(null);
      if (empty !== -1) this.slots[empty] = next;
    }
  }

  getPaneAtSlot(slot: number): string | null { return this.slots[slot] ?? null; }

  getSlotForPane(paneId: string): number { return this.slots.indexOf(paneId); }

  getAllPaneIds(): string[] { return this.slots.filter((s): s is string => s !== null); }

  markAsSplit(paneId: string): void { this.splitPanes.add(paneId); }

  isSplit(paneId: string): boolean { return this.splitPanes.has(paneId); }

  calculateGeometry(terminalWidth: number, terminalHeight: number, sidebarWidth: number): WheelGeometry {
    const contentWidth = terminalWidth - sidebarWidth - 1;
    const paneWidth = Math.floor((contentWidth - (this.config.columns - 1)) / this.config.columns);
    const paneHeight = Math.floor((terminalHeight - (this.config.rows - 1)) / this.config.rows);
    return { paneWidth, paneHeight, columns: this.config.columns, rows: this.config.rows };
  }

  reset(): void {
    this.slots.fill(null);
    this._overflowQueue = [];
    this.splitPanes.clear();
  }
}
