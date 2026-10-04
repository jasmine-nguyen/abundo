// WHIT-736 — the two Ask-button clearances carry the side they pad in their name, so the bottom
// gap (last row clears the button) can't be mixed up with the right lane (button never covers a row).
import { it, expect } from '@jest/globals';
import * as AskButtonModule from '../chat/AskButton';
import * as NavBarsHeaderModule from '../motion/useNavBarsHeader';
import { ASK_BUTTON_RIGHT_CLEARANCE } from '../chat/AskButton';
import { ASK_BUTTON_BOTTOM_CLEARANCE } from '../motion/useNavBarsHeader';

const OLD_NAME = ['ASK', 'BUTTON', 'CLEARANCE'].join('_');

it('exports the bottom clearance under a name that says bottom, value unchanged', () => {
  expect(ASK_BUTTON_BOTTOM_CLEARANCE).toBe(72);
  expect(Object.keys(NavBarsHeaderModule)).not.toContain(OLD_NAME);
});

it('exports the right-lane clearance under a name that says right, value unchanged', () => {
  expect(ASK_BUTTON_RIGHT_CLEARANCE).toBe(60);
  expect(Object.keys(AskButtonModule)).not.toContain(OLD_NAME);
});
