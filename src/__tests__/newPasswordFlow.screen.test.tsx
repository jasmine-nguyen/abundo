// WHIT-181 — the login screen's set-a-password step. A sign-in returning the
// NEW_PASSWORD_REQUIRED challenge flips the screen into the new-password form;
// mismatched confirms error without calling the SDK; matching confirms call
// completeNewPassword and enter the app; "back to sign in" returns to the form.
// ../../src/auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const mockSignInWithPassword = jest.fn<(e: string, p: string) => Promise<unknown>>();
const mockSignInWithGoogle = jest.fn<() => Promise<boolean>>();
const mockCompleteNewPassword = jest.fn<(p: string) => Promise<unknown>>();
jest.mock('../../src/auth', () => ({
  signInWithPassword: (...a: unknown[]) => mockSignInWithPassword(...(a as [string, string])),
  signInWithGoogle: () => mockSignInWithGoogle(),
  completeNewPassword: (...a: unknown[]) => mockCompleteNewPassword(...(a as [string])),
}));

import Login from '../../app/index';

// Sign in and land on the challenge → the new-password form is shown.
async function reachNewPasswordForm(api: ReturnType<typeof render>) {
  mockSignInWithPassword.mockResolvedValue({ ok: false, challenge: 'NEW_PASSWORD_REQUIRED' });
  fireEvent.changeText(api.getByTestId('login-email'), 'me@x.com');
  fireEvent.changeText(api.getByTestId('login-password'), 'Temp#123');
  fireEvent.press(api.getByTestId('login-submit'));
  await waitFor(() => expect(api.getByTestId('newpass-form')).toBeTruthy());
}

beforeEach(() => {
  mockReplace.mockReset();
  mockSignInWithPassword.mockReset();
  mockSignInWithGoogle.mockReset();
  mockCompleteNewPassword.mockReset();
});

it('the challenge flips the screen into the set-password form', async () => {
  const api = render(<Login />);
  await reachNewPasswordForm(api);
  // sign-in form gone, new-password form shown
  expect(api.queryByTestId('login-submit')).toBeNull();
  expect(api.getByTestId('newpass-new')).toBeTruthy();
  expect(api.getByTestId('newpass-confirm')).toBeTruthy();
});

it('mismatched passwords show an error and do NOT call completeNewPassword', async () => {
  const api = render(<Login />);
  await reachNewPasswordForm(api);
  fireEvent.changeText(api.getByTestId('newpass-new'), 'Str0ng#Pass');
  fireEvent.changeText(api.getByTestId('newpass-confirm'), 'different');
  fireEvent.press(api.getByTestId('newpass-submit'));
  expect(await api.findByText(/don.t match/i)).toBeTruthy();
  expect(mockCompleteNewPassword).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('matching passwords call completeNewPassword and enter the app on success', async () => {
  mockCompleteNewPassword.mockResolvedValue({ ok: true });
  const api = render(<Login />);
  await reachNewPasswordForm(api);
  fireEvent.changeText(api.getByTestId('newpass-new'), 'Str0ng#Pass');
  fireEvent.changeText(api.getByTestId('newpass-confirm'), 'Str0ng#Pass');
  fireEvent.press(api.getByTestId('newpass-submit'));
  await waitFor(() => expect(mockCompleteNewPassword).toHaveBeenCalledWith('Str0ng#Pass'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

it('a completeNewPassword error stays on the form (e.g. weak password), no navigation', async () => {
  mockCompleteNewPassword.mockResolvedValue({ ok: false, error: "That password doesn't meet the requirements. Try a stronger one." });
  const api = render(<Login />);
  await reachNewPasswordForm(api);
  fireEvent.changeText(api.getByTestId('newpass-new'), 'weak');
  fireEvent.changeText(api.getByTestId('newpass-confirm'), 'weak');
  fireEvent.press(api.getByTestId('newpass-submit'));
  expect(await api.findByText(/requirements/i)).toBeTruthy();
  expect(api.getByTestId('newpass-form')).toBeTruthy(); // still on the set-password step
  expect(mockReplace).not.toHaveBeenCalled();
});

it('"back to sign in" returns to the sign-in form', async () => {
  const api = render(<Login />);
  await reachNewPasswordForm(api);
  fireEvent.press(api.getByTestId('newpass-back'));
  await waitFor(() => expect(api.getByTestId('login-submit')).toBeTruthy());
  expect(api.queryByTestId('newpass-form')).toBeNull();
});
