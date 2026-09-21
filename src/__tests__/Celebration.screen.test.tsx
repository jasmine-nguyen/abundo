// WHIT-481 — the confetti overlay component in isolation. The Goals screen suite proves the wiring;
// these lock the overlay's OWN contract that the screen test doesn't reach: the "N checkpoints!"
// sub-line only shows for a multi-rung jump, key<=0 renders nothing, a NEW celebrationKey arriving
// mid-animation re-fires (extends the lifetime + refreshes the label) rather than being swallowed,
// and onDone fires exactly once when the timer elapses. Fake timers keep the setTimeout lifecycle
// deterministic; useReduceMotion is stubbed so the confetti-piece branch is exercised.
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

describe('Celebration overlay (WHIT-481)', () => {
  it('renders nothing at the initial key 0 (nothing celebrated yet)', () => {
    // [A-C1] key<=0 is the "no burst" sentinel — the overlay must stay absent.
    render(<Celebration celebrationKey={0} label="Holiday" />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('shows a single-checkpoint banner with NO "N checkpoints!" sub-line for a one-rung crossing', () => {
    // [A-C2] newlyReached 1 → banner only, no count sub-line.
    render(<Celebration celebrationKey={1} label="Holiday" newlyReached={1} />);
    expect(screen.getByText(/Holiday: checkpoint reached!/)).toBeTruthy();
    expect(screen.queryByText(/checkpoints!/)).toBeNull();
  });

  it('shows the "N checkpoints!" sub-line for a multi-rung jump', () => {
    // [A-C3] newlyReached 3 → the plural "3 checkpoints!" sub-line appears (copy for a big jump).
    render(<Celebration celebrationKey={1} label="Holiday" newlyReached={3} />);
    expect(screen.getByText('3 checkpoints!')).toBeTruthy();
  });

  it('falls back to a generic title when no label is given', () => {
    // [A-C4] label null/undefined → "Checkpoint reached!" with no "<name>:" prefix.
    render(<Celebration celebrationKey={1} label={null} newlyReached={1} />);
    expect(screen.getByText(/^Checkpoint reached!/)).toBeTruthy();
  });

  it('re-fires and refreshes the label when a new key arrives mid-animation', () => {
    // [A-C5] rapid successive crossings: fire key 1, advance PART way, then key 2 with a new label.
    // The overlay must still be visible, show the NEW label, and only clear a FULL FALL_MS after the
    // second burst — i.e. the second burst restarts the lifecycle, it isn't dropped.
    const { rerender } = render(<Celebration celebrationKey={1} label="Holiday" newlyReached={1} />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(800); });               // partway through the 1200ms life
    rerender(<Celebration celebrationKey={2} label="New car" newlyReached={1} />);
    expect(screen.getByText(/New car: checkpoint reached!/)).toBeTruthy();

    act(() => { jest.advanceTimersByTime(800); });               // 800 after burst 2: burst 1's old
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy(); // timer must NOT have hidden it
    act(() => { jest.advanceTimersByTime(400); });               // now full 1200ms past burst 2
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('calls onDone exactly once when the lifecycle timer elapses', () => {
    // [A-C6] onDone is the lifecycle hook the screen relies on — fires once, on timeout, not on mount.
    const onDone = jest.fn();
    render(<Celebration celebrationKey={1} label="Holiday" newlyReached={1} onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1200); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('reduce-motion still shows the banner and clears on the REDUCED_MS timer', () => {
    // [A-C7] motion off → banner shows, no confetti pieces, clears at 900ms not 1200ms.
    mockReduceMotion = true;
    render(<Celebration celebrationKey={1} label="Holiday" newlyReached={1} />);
    expect(screen.getByTestId('checkpoint-celebration-label')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(899); });
    expect(screen.queryByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
