import { useRef, useCallback } from 'react';
import { LEADER_KEY_CODE, LEADER_KEY_TIMEOUT } from '../constants/layout.js';

export type LeaderKeyState = 'idle' | 'pending';

export class LeaderKeyStateMachine {
  state: LeaderKeyState = 'idle';
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private onAction: (key: string) => void;

  constructor(onAction: (key: string) => void) {
    this.onAction = onAction;
  }

  handleInput(input: string): boolean {
    if (this.state === 'idle') {
      if (input === LEADER_KEY_CODE) {
        this.state = 'pending';
        this.timeoutId = setTimeout(() => { this.state = 'idle'; }, LEADER_KEY_TIMEOUT);
        return true;
      }
      return false;
    }

    // state === 'pending'
    this.clearTimeout();
    this.state = 'idle';
    this.onAction(input);
    return true;
  }

  private clearTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  destroy(): void {
    this.clearTimeout();
  }
}

export function useLeaderKey(onAction: (key: string) => void) {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  const machineRef = useRef<LeaderKeyStateMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = new LeaderKeyStateMachine((key) => onActionRef.current(key));
  }

  const handleInput = useCallback((input: string): boolean => {
    return machineRef.current!.handleInput(input);
  }, []);

  return { handleInput, state: machineRef.current.state };
}
