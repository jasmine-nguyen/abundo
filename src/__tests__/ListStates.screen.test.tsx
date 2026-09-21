// WHIT-489 — the shared cold-load/error component for the list tabs. Locks: per-prefix testIDs
// and copy, the retry wiring, and that NOTHING renders when neither state is active (the one edge
// the screen suites don't isolate). Spinner/error are driven by explicit booleans the caller
// computes (mutually exclusive on the real screens).
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ListStates } from '../components/ListStates';

it('renders the spinner (only) with the prefixed testID when loading', () => {
  render(<ListStates showSpinner showError={false} idPrefix="accounts" errorText="Couldn't load your accounts." retryLabel="Retry loading your accounts" onRetry={jest.fn()} />);
  expect(screen.getByTestId('accounts-loading')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
});

it('renders the error + retry with the prefixed testIDs and copy, and Retry fires onRetry', () => {
  const onRetry = jest.fn();
  render(<ListStates showSpinner={false} showError idPrefix="accounts" errorText="Couldn't load your accounts." retryLabel="Retry loading your accounts" onRetry={onRetry} />);
  expect(screen.getByTestId('accounts-error')).toBeTruthy();
  expect(screen.getByText("Couldn't load your accounts.")).toBeTruthy();
  fireEvent.press(screen.getByTestId('accounts-retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('carries the per-screen prefix and copy for the transactions screen', () => {
  render(<ListStates showSpinner={false} showError idPrefix="transactions" errorText="Couldn't load your transactions." retryLabel="Retry loading your transactions" onRetry={jest.fn()} />);
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
  expect(screen.getByText("Couldn't load your transactions.")).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
});

it('renders nothing when neither state is active', () => {
  render(<ListStates showSpinner={false} showError={false} idPrefix="accounts" errorText="x" retryLabel="y" onRetry={jest.fn()} />);
  expect(screen.queryByTestId('accounts-loading')).toBeNull();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
});
