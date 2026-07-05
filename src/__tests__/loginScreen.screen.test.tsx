// WHIT-180 — the rebuilt native login screen (app/index.tsx). Email/password calls
// signInWithPassword and enters the app on success; a failure / the
// NEW_PASSWORD_REQUIRED challenge surface as inline messages (no navigation);
// Continue with Google calls signInWithGoogle; Forgot password shows the WHIT-182
// coming-soon stub. ../../src/auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const mockSignInWithPassword = jest.fn<(e: string, p: string) => Promise<unknown>>();
const mockSignInWithGoogle = jest.fn<() => Promise<boolean>>();
jest.mock('../../src/auth', () => ({
  signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...(a as [string, string])),
  signInWithGoogle: () => mockSignInWithGoogle(),
}));

import Login from '../../app/index';

beforeEach(() => {
  mockReplace.mockReset();
  mockSignInWithPassword.mockReset();
  mockSignInWithGoogle.mockReset();
});

it('Log in calls signInWithPassword with the entered creds and enters the app on success', async () => {
  mockSignInWithPassword.mockResolvedValue({ ok: true });
  const { getByTestId } = render(<Login />);
  fireEvent.changeText(getByTestId('login-email'), 'me@x.com');
  fireEvent.changeText(getByTestId('login-password'), 'secret');
  fireEvent.press(getByTestId('login-submit'));
  await waitFor(() => expect(mockSignInWithPassword).toHaveBeenCalledWith('me@x.com', 'secret'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

it('shows the error message on a failed sign-in and does NOT navigate', async () => {
  mockSignInWithPassword.mockResolvedValue({ ok: false, error: 'Incorrect email or password.' });
  const { getByTestId, findByText } = render(<Login />);
  fireEvent.changeText(getByTestId('login-email'), 'me@x.com');
  fireEvent.changeText(getByTestId('login-password'), 'wrong');
  fireEvent.press(getByTestId('login-submit'));
  expect(await findByText('Incorrect email or password.')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('the NEW_PASSWORD_REQUIRED challenge flips into the set-password form, no navigation', async () => {
  mockSignInWithPassword.mockResolvedValue({ ok: false, challenge: 'NEW_PASSWORD_REQUIRED' });
  const { getByTestId, findByTestId } = render(<Login />);
  fireEvent.changeText(getByTestId('login-email'), 'me@x.com');
  fireEvent.changeText(getByTestId('login-password'), 'temp');
  fireEvent.press(getByTestId('login-submit'));
  expect(await findByTestId('newpass-form')).toBeTruthy(); // WHIT-181: set-password step
  expect(mockReplace).not.toHaveBeenCalled();
});

it('Continue with Google calls signInWithGoogle and enters the app on success', async () => {
  mockSignInWithGoogle.mockResolvedValue(true);
  const { getByTestId } = render(<Login />);
  fireEvent.press(getByTestId('login-google'));
  await waitFor(() => expect(mockSignInWithGoogle).toHaveBeenCalled());
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

it('a cancelled Google sign-in (false) stays on the screen, no navigation', async () => {
  mockSignInWithGoogle.mockResolvedValue(false);
  const { getByTestId } = render(<Login />);
  fireEvent.press(getByTestId('login-google'));
  await waitFor(() => expect(mockSignInWithGoogle).toHaveBeenCalled());
  expect(mockReplace).not.toHaveBeenCalled();
});

it('Forgot password opens the reset-code request form (WHIT-182)', () => {
  const { getByTestId } = render(<Login />);
  fireEvent.press(getByTestId('login-forgot'));
  expect(getByTestId('forgot-request-form')).toBeTruthy();
});
