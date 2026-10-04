// WHIT-736 — the Ask-button bottom clearance carries the side it pads in its name, so the bottom
// gap (last row clears the button) can't be mistaken for anything else.
import { it, expect } from '@jest/globals';
import * as NavBarsHeaderModule from '../motion/useNavBarsHeader';
import { ASK_BUTTON_BOTTOM_CLEARANCE } from '../motion/useNavBarsHeader';

const OLD_NAME = ['ASK', 'BUTTON', 'CLEARANCE'].join('_');

it('exports the bottom clearance under a name that says bottom, value unchanged', () => {
  expect(ASK_BUTTON_BOTTOM_CLEARANCE).toBe(72);
  expect(Object.keys(NavBarsHeaderModule)).not.toContain(OLD_NAME);
});
