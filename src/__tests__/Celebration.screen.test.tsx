// WHIT-481 / WHIT-747 — the confetti overlay component in isolation. The Goals screen suite proves the
// wiring; these lock the overlay's OWN contract: the banner sits on a backing card and names the
// milestone, key<=0 renders nothing, the overlay never blocks taps, a NEW celebrationKey arriving
// mid-way re-fires (extends the lifetime + refreshes the label) rather than being swallowed, onDone
// fires exactly once when the timer elapses, and reduce-motion drops the confetti but keeps the
// banner for the same time. Fake timers keep the setTimeout lifecycle deterministic.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import { Celebration } from '../components/Celebration';

beforeEach(() => {
  mockReduceMotion = false;
  jest.useFakeTimers();
});
afterEach(() => { jest.useRealTimers(); });

describe('Celebration overlay', () => {
  it('renders nothing at the initial key 0 (nothing celebrated yet)', () => {
    render(<Celebration celebrationKey={0} label="Holiday · $5,000 reached" />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('shows the milestone on a backing card, without blocking taps', () => {
    render(<Celebration celebrationKey={1} label="Offset · $150,000 reached" />);
    expect(screen.getByTestId('checkpoint-celebration-label')).toHaveTextContent('Offset · $150,000 reached 🎉');
    expect(screen.getByTestId('checkpoint-celebration-banner')).toBeTruthy();
    expect(screen.getByTestId('checkpoint-celebration').props.pointerEvents).toBe('none');
    expect(screen.getAllByTestId('celebration-piece').length).toBeGreaterThan(0);
  });

  it('re-fires and refreshes the label when a new key arrives mid-way', () => {
    const { rerender } = render(<Celebration celebrationKey={1} label="Holiday · $2,000 reached" />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(1600); });              // partway through the 2400ms life
    rerender(<Celebration celebrationKey={2} label="New car · goal reached" />);
    expect(screen.getByText(/New car · goal reached/)).toBeTruthy();

    act(() => { jest.advanceTimersByTime(1600); });              // burst 1's old timer must NOT hide it
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(800); });               // now a full 2400ms past burst 2
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('calls onDone exactly once when the lifecycle timer elapses', () => {
    const onDone = jest.fn();
    render(<Celebration celebrationKey={1} label="Holiday · $2,000 reached" onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(2400); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('reduce-motion shows the banner with no confetti and clears it after the same time', () => {
    mockReduceMotion = true;
    render(<Celebration celebrationKey={1} label="Holiday · $2,000 reached" />);
    expect(screen.getByTestId('checkpoint-celebration-banner')).toBeTruthy();
    expect(screen.queryAllByTestId('celebration-piece')).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(2399); });
    expect(screen.queryByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
