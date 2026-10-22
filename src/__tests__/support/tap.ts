// A tap whose work the test holds open (a save that hasn't answered yet). Awaiting fireEvent.press
// also waits for the work its handler returns, which would hang on a held save, so this taps
// every element in the same frame — before the screen redraws, like a fast double-tap — lets the
// screen redraw, and hands back `settled` to await once the test lets that work finish.
import { act, fireEvent } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

export async function startTaps(...elements: TestInstance[]) {
  let taps: Promise<unknown>[] = [];
  await act(async () => {
    taps = elements.map((element) => fireEvent.press(element));
  });
  return { settled: Promise.all(taps) };
}
