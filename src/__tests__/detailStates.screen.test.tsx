// WHIT-276 — the shared cache-first scaffold pulled out of the transaction/[id] and
// account/[id] detail screens. Pure component: no mocking, just render it with props and
// assert the gate. The two screen tests (transactionDetail/accountDetail) still pin the
// real wiring; this pins the extracted piece on its own so a future "cleanup" can't quietly
// drop a state.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { DetailStates } from '../components/DetailStates';

const props = (over: Record<string, unknown> = {}) => ({
  isLoading: false, isError: false, hasCache: false,
  idPrefix: 'thing', errorText: "Couldn't load it.", retryLabel: 'Retry loading it',
  onRetry: jest.fn(), ...over,
});

const child = <Text testID="thing-content">loaded</Text>;

it('loading with nothing cached shows the spinner and hides the children', () => {
  render(<DetailStates {...props({ isLoading: true })}>{child}</DetailStates>);
  expect(screen.getByTestId('thing-loading')).toBeTruthy();
  expect(screen.queryByTestId('thing-content')).toBeNull();
});

it('error with nothing cached shows an accessible Retry that re-issues the read, children hidden', () => {
  const onRetry = jest.fn();
  render(<DetailStates {...props({ isError: true, onRetry })}>{child}</DetailStates>);

  expect(screen.getByTestId('thing-error')).toBeTruthy();
  expect(screen.getByText("Couldn't load it.")).toBeTruthy(); // the passed errorText actually renders
  const retry = screen.getByTestId('thing-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading it');
  expect(screen.queryByTestId('thing-content')).toBeNull();

  fireEvent.press(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('settled (not loading, not error) renders the children and no scaffold', () => {
  render(<DetailStates {...props()}>{child}</DetailStates>);
  expect(screen.getByTestId('thing-content')).toBeTruthy();
  expect(screen.queryByTestId('thing-loading')).toBeNull();
  expect(screen.queryByTestId('thing-error')).toBeNull();
});

it('a failure OVER cached rows stays cache-first: children shown, no error', () => {
  render(<DetailStates {...props({ isError: true, hasCache: true })}>{child}</DetailStates>);
  expect(screen.getByTestId('thing-content')).toBeTruthy();
  expect(screen.queryByTestId('thing-error')).toBeNull();
});

// The spinner and error are independent conditions (isLoading/isError come from two combined
// queries and can both be true with an empty cache), so both blocks render stacked — matching
// the pre-refactor screens. Guards against a future collapse into an either/or.
it('loading AND error with nothing cached renders both the spinner and the error', () => {
  render(<DetailStates {...props({ isLoading: true, isError: true })}>{child}</DetailStates>);
  expect(screen.getByTestId('thing-loading')).toBeTruthy();
  expect(screen.getByTestId('thing-error')).toBeTruthy();
  expect(screen.queryByTestId('thing-content')).toBeNull();
});
