import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LeaderKeyStateMachine } from '../src/hooks/useLeaderKey.js';
import { LEADER_KEY_CODE, LEADER_KEY_TIMEOUT } from '../src/constants/layout.js';

describe('LeaderKeyStateMachine', () => {
  let machine: LeaderKeyStateMachine;
  let onAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onAction = vi.fn();
    machine = new LeaderKeyStateMachine(onAction);
  });

  afterEach(() => {
    vi.useRealTimers();
    machine.destroy();
  });

  it('starts idle', () => {
    expect(machine.state).toBe('idle');
  });

  it('transitions to pending on leader key', () => {
    expect(machine.handleInput(LEADER_KEY_CODE)).toBe(true);
    expect(machine.state).toBe('pending');
  });

  it('dispatches action on follow-up key', () => {
    machine.handleInput(LEADER_KEY_CODE);
    machine.handleInput('m');
    expect(onAction).toHaveBeenCalledWith('m');
    expect(machine.state).toBe('idle');
  });

  it('resets after timeout', () => {
    machine.handleInput(LEADER_KEY_CODE);
    vi.advanceTimersByTime(LEADER_KEY_TIMEOUT + 1);
    expect(machine.state).toBe('idle');
  });

  it('does not dispatch after timeout', () => {
    machine.handleInput(LEADER_KEY_CODE);
    vi.advanceTimersByTime(LEADER_KEY_TIMEOUT + 1);
    machine.handleInput('m');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('ignores non-leader keys in idle', () => {
    expect(machine.handleInput('x')).toBe(false);
  });

  it('dispatches number keys', () => {
    machine.handleInput(LEADER_KEY_CODE);
    machine.handleInput('3');
    expect(onAction).toHaveBeenCalledWith('3');
  });
});
