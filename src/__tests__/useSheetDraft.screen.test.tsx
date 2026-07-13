// WHIT-285 — useSheetDraft, the shared "draft survives a Face ID lock" plumbing extracted from
// the three sheets in Overlays.tsx. renderHook drives the hook directly; ../context is mocked so
// readSheetDraft/writeSheetDraft are spies backed by a real Map (the provider's ref-map stand-in),
// letting us assert the lazy read, the cast handed to init, and the persist timing in isolation.
// The three sheet screen tests still pin the wired behaviour; this pins the seam.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

const mockStore = new Map<string, unknown>();
const mockReadSheetDraft = jest.fn((key: string): unknown => mockStore.get(key));
const mockWriteSheetDraft = jest.fn((key: string, value: unknown) => { mockStore.set(key, value); });
jest.mock('../context', () => ({
  useAppContext: () => ({ readSheetDraft: mockReadSheetDraft, writeSheetDraft: mockWriteSheetDraft }),
}));

import { useSheetDraft } from '../hooks/useSheetDraft';

beforeEach(() => {
  mockStore.clear();
  mockReadSheetDraft.mockClear();
  mockWriteSheetDraft.mockClear();
});

// Lazy init: reads the key exactly once on mount, hands the (cast) stored draft to init, and
// returns init's output. A re-render must NOT re-read — the read is a useState initializer.
it('reads the key once on mount, casts the stored draft into init, and returns its result', () => {
  mockStore.set('k', { count: 7 });
  const init = jest.fn((draft: { count: number } | undefined) => ({ count: draft?.count ?? 0 }));
  const { result, rerender } = renderHook(() => useSheetDraft<{ count: number }>('k', init));

  expect(mockReadSheetDraft).toHaveBeenCalledTimes(1);
  expect(mockReadSheetDraft).toHaveBeenCalledWith('k');
  expect(init).toHaveBeenCalledWith({ count: 7 }); // the unknown store value, typed for init
  expect(result.current[0]).toEqual({ count: 7 });

  rerender(undefined);
  expect(mockReadSheetDraft).toHaveBeenCalledTimes(1); // lazy init never re-reads
});

// No stored draft → init receives undefined so each sheet's own fallback runs.
it('hands init undefined when nothing is stored, so the fallback is used', () => {
  const { result } = renderHook(() => useSheetDraft<string>('k', (draft) => draft ?? 'fallback'));
  expect(mockReadSheetDraft).toHaveBeenCalledWith('k');
  expect(result.current[0]).toBe('fallback');
});

// Persist: writes the committed value on mount (matching the hand-copied effects), then on every
// change. The write comes from the value effect, not the setter, so it reflects committed state.
it('persists the initial value on mount and the new value on every change', () => {
  const { result } = renderHook(() => useSheetDraft<string>('k', (draft) => draft ?? 'init'));
  expect(mockWriteSheetDraft).toHaveBeenCalledWith('k', 'init'); // mount write

  act(() => { result.current[1]('typed'); });
  expect(mockWriteSheetDraft).toHaveBeenLastCalledWith('k', 'typed');
  expect(mockStore.get('k')).toBe('typed');
});

// Stability: readSheetDraft/writeSheetDraft are stable (useCallback([], ...)), so a re-render with
// an unchanged value must NOT re-persist — the effect deps [value, key, writeSheetDraft] hold.
it('does not re-persist on a re-render when the value is unchanged', () => {
  const { rerender } = renderHook(() => useSheetDraft<string>('k', (draft) => draft ?? 'init'));
  expect(mockWriteSheetDraft).toHaveBeenCalledTimes(1); // the mount write only

  rerender(undefined);
  expect(mockWriteSheetDraft).toHaveBeenCalledTimes(1); // no spurious re-write
});
