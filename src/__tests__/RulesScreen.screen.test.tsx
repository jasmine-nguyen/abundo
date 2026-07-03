// Screen test: the Rules screen (WHIT-52 Slice 2). Verifies the loading and
// error+retry states and that a loaded rule renders + its trash button calls
// deleteRule. Context is injected via the jest.mock('../context') pattern.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Header pulls in expo-router (a native module that can't load headlessly) and
// isn't under test here — stub it out so the screen renders in jest.
jest.mock('../components/Header', () => ({ Header: () => null }));

import Rules from '../../app/rules';

const fns = {
  setSheet: jest.fn(),
  deleteRule: jest.fn(),
  refreshEnrichments: jest.fn(),
};

function state(over: Partial<AppContext>): AppContext {
  return {
    rules: [],
    enrichmentsLoading: false,
    enrichmentsError: null,
    category: (id: string | null) =>
      id === 'subs' ? { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 } : undefined,
    ...fns,
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => {
  fns.setSheet.mockClear();
  fns.deleteRule.mockClear();
  fns.refreshEnrichments.mockClear();
});

it('shows a loading state while rules load', () => {
  mockState = state({ enrichmentsLoading: true, rules: [] });
  render(<Rules />);
  expect(screen.getByText('Loading rules…')).toBeTruthy();
});

it('shows an error with a retry that refreshes', () => {
  mockState = state({ enrichmentsError: 'Could not load rules.' });
  render(<Rules />);
  expect(screen.getByText('Could not load rules.')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  expect(fns.refreshEnrichments).toHaveBeenCalled();
});

it('renders a rule and deletes it via the trash button', () => {
  mockState = state({ rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }] });
  render(<Rules />);
  expect(screen.getByText('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Subscriptions')).toBeTruthy();
  fireEvent.press(screen.getByTestId('delete-rule-e1'));
  expect(fns.deleteRule).toHaveBeenCalledWith('e1');
});
