// WHIT-184 GAP — useReduceMotion, the single source of truth for the OS reduce-motion flag
// that gates EVERY motion in the app (scroll-to-hide tween, tab-switch, stack push). Locks:
//   - defaults to false (motion on) before the async probe resolves
//   - reflects the OS value once isReduceMotionEnabled resolves
//   - live-updates when the OS 'reduceMotionChanged' event fires
//   - unsubscribes on unmount (no setState-after-unmount)
//   - stays false (never crashes) if the probe rejects (jest/web env without the native module)
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useReduceMotion } from '../motion/useReduceMotion';

let changeHandler: ((enabled: boolean) => void) | undefined;
const remove = jest.fn();

beforeEach(() => {
  changeHandler = undefined;
  remove.mockClear();
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((_event: string, cb: (e: boolean) => void) => {
    changeHandler = cb;
    return { remove } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
  }) as typeof AccessibilityInfo.addEventListener);
});

afterEach(() => { jest.restoreAllMocks(); });

it('defaults to false, then reflects the OS value once the probe resolves', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const { result } = renderHook(() => useReduceMotion());
  expect(result.current).toBe(false); // initial synchronous render, before the promise settles
  await waitFor(() => expect(result.current).toBe(true));
});

it('live-updates when the OS reduceMotionChanged event fires', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const { result } = renderHook(() => useReduceMotion());
  await waitFor(() => expect(changeHandler).toBeDefined());

  act(() => changeHandler!(true));
  expect(result.current).toBe(true);
  act(() => changeHandler!(false));
  expect(result.current).toBe(false);
});

it('removes its subscription on unmount', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const { unmount } = renderHook(() => useReduceMotion());
  await waitFor(() => expect(changeHandler).toBeDefined());
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('stays false (no crash) when the reduce-motion probe rejects', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockRejectedValue(new Error('no native module'));
  const { result } = renderHook(() => useReduceMotion());
  // give the rejected promise a tick to be swallowed by the hook's .catch
  await act(async () => { await Promise.resolve(); });
  expect(result.current).toBe(false);
});
