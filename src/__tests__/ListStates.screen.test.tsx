// WHIT-489 — the shared cold-load/error component for the list tabs. Locks: per-prefix testIDs
// and copy, the retry wiring, and that NOTHING renders when neither state is active (the one edge
// the screen suites don't isolate). Spinner/error are driven by explicit booleans the caller
// computes (mutually exclusive on the real screens).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ListStates, StaleDataLine } from '../components/ListStates';
import { pinToday } from './support/clock';

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

it('with an error, adds the reason line under the error copy', () => {
  render(<ListStates showSpinner={false} showError idPrefix="accounts" errorText="Couldn't load your accounts." retryLabel="y" onRetry={jest.fn()} error={new TypeError('Network request failed')} />);
  expect(screen.getByText("Couldn't load your accounts.")).toBeTruthy();
  expect(screen.getByText('You look offline. Check your connection and retry.')).toBeTruthy();
});

it('without an error, shows no reason line', () => {
  render(<ListStates showSpinner={false} showError idPrefix="accounts" errorText="Couldn't load your accounts." retryLabel="y" onRetry={jest.fn()} />);
  expect(screen.queryByText(/look offline|server had a problem/)).toBeNull();
});

describe('StaleDataLine (WHIT-713)', () => {
  beforeEach(() => { pinToday(new Date('2026-09-18T15:00:00+10:00')); });
  afterEach(() => { jest.useRealTimers(); });

  const loadedAt = new Date('2026-09-18T09:40:00+10:00').getTime();

  it('renders nothing with no refresh error', () => {
    render(<StaleDataLine idPrefix="budgets" error={null} updatedAt={loadedAt} />);
    expect(screen.queryByTestId('budgets-stale')).toBeNull();
  });

  it('renders nothing when nothing has loaded yet', () => {
    render(<StaleDataLine idPrefix="budgets" error={new Error('API error: 503')} updatedAt={0} />);
    expect(screen.queryByTestId('budgets-stale')).toBeNull();
  });

  it('says it could not refresh, with the load time, for a server error', () => {
    render(<StaleDataLine idPrefix="budgets" error={new Error('API error: 503')} updatedAt={loadedAt} />);
    expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am");
  });

  it('says you look offline for a lost connection', () => {
    render(<StaleDataLine idPrefix="accounts" error={new TypeError('Network request failed')} updatedAt={loadedAt} />);
    expect(screen.getByTestId('accounts-stale')).toHaveTextContent('You look offline · showing 9:40am');
  });

  // WHIT-844: the opt-in success version. Without the opt-in a good load still shows nothing
  // (the first case above).
  it('with showUpdated, says when a good load happened', () => {
    render(<StaleDataLine idPrefix="budgets" error={null} updatedAt={loadedAt} showUpdated />);
    expect(screen.getByTestId('budgets-updated')).toHaveTextContent('Updated 9:40am');
    expect(screen.queryByTestId('budgets-stale')).toBeNull();
  });

  it('with showUpdated, a failed refresh still shows only the stale line', () => {
    render(<StaleDataLine idPrefix="budgets" error={new Error('API error: 503')} updatedAt={loadedAt} showUpdated />);
    expect(screen.getByTestId('budgets-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am");
    expect(screen.queryByTestId('budgets-updated')).toBeNull();
  });

  it('with showUpdated, renders nothing when nothing has loaded yet', () => {
    render(<StaleDataLine idPrefix="budgets" error={null} updatedAt={0} showUpdated />);
    expect(screen.queryByTestId('budgets-updated')).toBeNull();
  });
});
