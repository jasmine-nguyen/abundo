// WHIT-736 QA — the renamed bottom clearance still pads the BOTTOM of every tab list, and the
// right-lane value isn't swapped in. Literal 192 (120 tab bar + 72 Ask button) pins "no change on screen".
import { it, expect } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { useNavBarsHeader } from '../motion/useNavBarsHeader';

// [A1]
it('tab lists keep 192pt of bottom padding (tab bar + Ask button) after the rename', () => {
  const { result } = renderHook(() => useNavBarsHeader());
  expect(result.current.contentPadding.paddingBottom).toBe(192);
});
