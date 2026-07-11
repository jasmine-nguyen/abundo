// WHIT-233 — the /goal/edit placeholder must not dead-end: its <Header showBack /> back
// button routes back. The goalEdit suite locks the title/placeholder; this locks the ONE
// interactive affordance the stub has. The header's back Pressable is the only accessible
// host node on the screen (the placeholder has no other pressables). useRouter is shared by
// the screen AND the Header, so a single stable mockBack observes the call.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockBack = jest.fn();
let mockParams: { id?: string };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));

import GoalEdit from '../../app/goal/edit';

beforeEach(() => {
  mockBack.mockClear();
  mockParams = {};
});

// [A27] tapping the header back button routes back (the stub's only exit).
it('the back button routes back', () => {
  render(<GoalEdit />);
  const pressables = screen.root.findAll((n) => n.props?.accessible === true && typeof n.type === 'string');
  expect(pressables).toHaveLength(1); // only the Header back Pressable is accessible
  fireEvent.press(pressables[0]);
  expect(mockBack).toHaveBeenCalledTimes(1);
});
