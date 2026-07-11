// WHIT-233 — the /goal/edit placeholder (the real add/edit form is WHIT-234). Locks that the
// hub's "+" and card taps don't dead-end: the route renders a titled screen with a back button,
// and the title reflects add vs edit from the `id` param. useSafeAreaInsets is stubbed globally
// (jest.setup); expo-router is mocked for the param + router.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

let mockParams: { id?: string };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn() }),
}));

import GoalEdit from '../../app/goal/edit';

beforeEach(() => { mockParams = {}; });

it('renders the "Add a goal" placeholder when there is no id', () => {
  render(<GoalEdit />);
  expect(screen.getByText('Add a goal')).toBeTruthy();
  expect(screen.getByTestId('goal-edit-placeholder')).toBeTruthy();
  expect(screen.getByText('Coming soon')).toBeTruthy();
});

it('titles the screen "Edit goal" when an id is supplied', () => {
  mockParams = { id: 'g1' };
  render(<GoalEdit />);
  expect(screen.getByText('Edit goal')).toBeTruthy();
  expect(screen.getByTestId('goal-edit-placeholder')).toBeTruthy();
});
