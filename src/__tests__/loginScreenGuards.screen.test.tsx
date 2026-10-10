// WHIT-180 — adversarial guards for the native login screen the base
// loginScreen.screen.test.tsx doesn't lock: the busy latch (double-tap = one call),
// cross-button blocking, the keyboard "go" submit, error-clears-on-retry, the
// empty-field disable, and that a thrown auth call clears busy + shows a generic error
// (not a stuck spinner). ../../src/auth + expo-router mocked (mirrors the base suite).
import { it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const mockSignInWithPassword = jest.fn<(e: string, p: string) => Promise<unknown>>();
const mockSignInWithGoogle = jest.fn<() => Promise<import('../auth').OAuthSignInResult>>();
jest.mock('../../src/auth', () => ({
  signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...(a as [string, string])),
  signInWithGoogle: () => mockSignInWithGoogle(),
}));

import Login from '../../app/index';

/** Fill the fields so the Log in button is enabled (canSubmit). */
function fill(getByTestId: (id: string) => unknown) {
  fireEvent.changeText(getByTestId('login-email') as never, 'me@x.com');
  fireEvent.changeText(getByTestId('login-password') as never, 'secret');
}

beforeEach(() => {
  resetRouter();
  mockSignInWithPassword.mockReset();
  mockSignInWithGoogle.mockReset();
});

it('Log in does nothing while the fields are empty (disabled)', () => {
  const { getByTestId } = render(<Login />);
  fireEvent.press(getByTestId('login-submit'));
  expect(mockSignInWithPassword).not.toHaveBeenCalled();
});

it('double-tapping Log in only starts ONE password sign-in (busy latch)', async () => {
  mockSignInWithPassword.mockReturnValue(new Promise<never>(() => {})); // never resolves
  const { getByTestId } = render(<Login />);
  fill(getByTestId);
  fireEvent.press(getByTestId('login-submit'));
  fireEvent.press(getByTestId('login-submit'));
  fireEvent.press(getByTestId('login-submit'));
  await waitFor(() => expect(mockSignInWithPassword).toHaveBeenCalledTimes(1));
});

it.each([
  ['Continue with Google', 'login-submit', 'login-google'],
  ['a password sign-in', 'login-google', 'login-submit'],
] as const)('%s is ignored while the other sign-in is mid-flight', async (_case, first, second) => {
  mockSignInWithPassword.mockReturnValue(new Promise<never>(() => {}));
  mockSignInWithGoogle.mockReturnValue(new Promise<never>(() => {}));
  const firstCall = first === 'login-submit' ? mockSignInWithPassword : mockSignInWithGoogle;
  const secondCall = second === 'login-submit' ? mockSignInWithPassword : mockSignInWithGoogle;
  const { getByTestId } = render(<Login />);
  fill(getByTestId);
  fireEvent.press(getByTestId(first));
  await waitFor(() => expect(firstCall).toHaveBeenCalledTimes(1));
  fireEvent.press(getByTestId(second));
  expect(secondCall).not.toHaveBeenCalled();
});

it('the keyboard "go" key (onSubmitEditing) submits the password sign-in', async () => {
  mockSignInWithPassword.mockResolvedValue({ ok: true });
  const { getByTestId } = render(<Login />);
  fill(getByTestId);
  fireEvent(getByTestId('login-password'), 'submitEditing');
  await waitFor(() => expect(mockSignInWithPassword).toHaveBeenCalledWith('me@x.com', 'secret'));
  await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

it('clears an earlier error once a retry succeeds', async () => {
  mockSignInWithPassword
    .mockResolvedValueOnce({ ok: false, error: 'Incorrect email or password.' })
    .mockResolvedValueOnce({ ok: true });
  const { getByTestId, findByText, queryByText } = render(<Login />);
  fill(getByTestId);
  fireEvent.press(getByTestId('login-submit'));
  expect(await findByText('Incorrect email or password.')).toBeTruthy();
  fireEvent.press(getByTestId('login-submit'));
  await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledWith('/(tabs)/budgets'));
  expect(queryByText('Incorrect email or password.')).toBeNull();
});

it('a THROWN auth call clears busy and shows a generic error (not a stuck spinner)', async () => {
  // signInWithPassword is never-throw by contract; the try/catch is belt-and-braces.
  // Fail-on-revert: removing it leaves busy stuck and no error box.
  mockSignInWithPassword.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true });
  const { getByTestId, findByText } = render(<Login />);
  fill(getByTestId);
  fireEvent.press(getByTestId('login-submit'));
  expect(await findByText(/something went wrong/i)).toBeTruthy();
  // busy cleared → a retry actually runs and navigates (proves not stuck).
  fireEvent.press(getByTestId('login-submit'));
  await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledWith('/(tabs)/budgets'));
});
