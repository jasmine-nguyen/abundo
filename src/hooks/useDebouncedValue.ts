import { useEffect, useState } from 'react';

// WHIT-354: return `value` delayed until it has stopped changing for `delayMs` — a
// standard trailing debounce. Each new value cancels the previous pending update, so a
// burst of rapid changes only settles once, `delayMs` after the last one. Seeded with the
// first value, so the initial render is immediate (no blank first frame).
//
// Used to keep an expensive derivation off the typing hot path: a controlled input reads
// the live value (instant keystrokes) while its debounced copy drives the filter/recompute.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
