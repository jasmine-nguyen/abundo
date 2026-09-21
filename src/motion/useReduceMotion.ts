// WHIT-184 — single source of truth for the OS "reduce motion" accessibility flag.
// When the user has reduce-motion on, all of the app's motion (scroll-to-hide, tab
// switch, stack push) must fall back to instant. Defaults to false (motion on) and
// tolerates the jest/web env where the native module may be absent.
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    // Guard the call itself: some RN test/web environments don't implement it.
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => { if (active) setReduceMotion(enabled); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled: boolean) => {
      setReduceMotion(enabled);
    });
    return () => {
      active = false;
      sub?.remove?.();
    };
  }, []);

  return reduceMotion;
}
