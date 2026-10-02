// Shared clock helpers for screen tests. (Not a *.test file, so Jest never runs it as a suite.)
import { jest } from '@jest/globals';

/** Pin today's date only. Timers stay real, so the fake server's replies and waitFor still settle. */
export function pinToday(now: Date) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
      'nextTick', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
}
