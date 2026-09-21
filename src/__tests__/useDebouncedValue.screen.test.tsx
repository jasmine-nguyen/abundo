// WHIT-354: the trailing-debounce hook behind the Rules search. Locks: immediate seed
// (no blank first frame), the value only settles after the delay, and a burst of rapid
// changes settles ONCE on the last value (each change cancels the pending update).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('useDebouncedValue', () => {
  it('returns the initial value immediately (no blank first frame)', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 250));
    expect(result.current).toBe('hello');
  });

  it('holds the old value until the delay elapses, then updates', () => {
    const { result, rerender } = renderHook(({ value }: { value: string }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    expect(result.current).toBe('a'); // not yet
    act(() => { jest.advanceTimersByTime(249); });
    expect(result.current).toBe('a'); // still not
    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current).toBe('b'); // settled
  });

  it('collapses a burst of rapid changes into one settle on the last value', () => {
    const { result, rerender } = renderHook(({ value }: { value: string }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'ab' });
    act(() => { jest.advanceTimersByTime(100); });
    rerender({ value: 'abc' });
    act(() => { jest.advanceTimersByTime(100); });
    rerender({ value: 'abcd' });
    // Only 200ms of the last change's 250ms has passed via the intervening advances; the
    // earlier timers were cancelled, so the value is still the original.
    expect(result.current).toBe('a');
    act(() => { jest.advanceTimersByTime(250); });
    expect(result.current).toBe('abcd'); // one settle, on the final value
  });
});
