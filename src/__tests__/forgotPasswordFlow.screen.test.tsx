// WHIT-182 — the login screen's forgot-password flow: request a code → confirm it
// with a new password → back to sign in. ../../src/auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const mockRequestReset = jest.fn<(e: string) => Promise<unknown>>();
const mockConfirmReset = jest.fn<(e: string, c: string, p: string) => Promise<unknown>>();
jest.mock('../../src/auth', () => ({
  signInWithPassword: jest.fn(async () => ({ ok: true })),
  signInWithGoogle: jest.fn(async () => false),
  completeNewPassword: jest.fn(async () => ({ ok: true })),
  requestPasswordReset: (...a: unknown[]) => mockRequestReset(...(a as [string])),
  confirmPasswordReset: (...a: unknown[]) => mockConfirmReset(...(a as [string, string, string])),
}));

import Login from '../../app/index';

// Open the forgot flow and get to the confirm form (code sent).
async function reachConfirm(api: ReturnType<typeof render>) {
  fireEvent.press(api.getByTestId('login-forgot'));
  fireEvent.changeText(api.getByTestId('forgot-email'), 'me@x.com');
  mockRequestReset.mockResolvedValue({ ok: true });
  fireEvent.press(api.getByTestId('forgot-send'));
  await waitFor(() => expect(api.getByTestId('forgot-confirm-form')).toBeTruthy());
}

beforeEach(() => {
  mockReplace.mockReset();
  mockRequestReset.mockReset();
  mockConfirmReset.mockReset();
});

it('Forgot password → request form → send code → confirm form (with a notice)', async () => {
  const api = render(<Login />);
  fireEvent.press(api.getByTestId('login-forgot'));
  expect(api.getByTestId('forgot-request-form')).toBeTruthy();

  fireEvent.changeText(api.getByTestId('forgot-email'), 'me@x.com');
  mockRequestReset.mockResolvedValue({ ok: true });
  fireEvent.press(api.getByTestId('forgot-send'));

  await waitFor(() => expect(mockRequestReset).toHaveBeenCalledWith('me@x.com'));
  await waitFor(() => expect(api.getByTestId('forgot-confirm-form')).toBeTruthy());
  expect(api.getByTestId('login-notice')).toBeTruthy();
});

it('a failed send stays on the request form with the error', async () => {
  const api = render(<Login />);
  fireEvent.press(api.getByTestId('login-forgot'));
  fireEvent.changeText(api.getByTestId('forgot-email'), 'me@x.com');
  mockRequestReset.mockResolvedValue({ ok: false, error: 'Too many attempts. Try again in a bit.' });
  fireEvent.press(api.getByTestId('forgot-send'));
  expect(await api.findByText(/too many/i)).toBeTruthy();
  expect(api.getByTestId('forgot-request-form')).toBeTruthy();
});

it('mismatched new passwords error without calling confirmPasswordReset', async () => {
  const api = render(<Login />);
  await reachConfirm(api);
  fireEvent.changeText(api.getByTestId('forgot-code'), '123456');
  fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'different');
  fireEvent.press(api.getByTestId('forgot-submit'));
  expect(await api.findByText(/don.t match/i)).toBeTruthy();
  expect(mockConfirmReset).not.toHaveBeenCalled();
});

it('a valid code + matching password resets and returns to sign in with a notice', async () => {
  const api = render(<Login />);
  await reachConfirm(api);
  mockConfirmReset.mockResolvedValue({ ok: true });
  fireEvent.changeText(api.getByTestId('forgot-code'), '123456');
  fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'Str0ng#Pass');
  fireEvent.press(api.getByTestId('forgot-submit'));

  await waitFor(() => expect(mockConfirmReset).toHaveBeenCalledWith('me@x.com', '123456', 'Str0ng#Pass'));
  await waitFor(() => expect(api.getByTestId('signin-form')).toBeTruthy());
  expect(await api.findByText(/password reset/i)).toBeTruthy(); // notice on the sign-in screen
  expect(mockReplace).not.toHaveBeenCalled(); // reset does NOT auto-sign-in
});

it('a bad code stays on the confirm form with the error', async () => {
  const api = render(<Login />);
  await reachConfirm(api);
  mockConfirmReset.mockResolvedValue({ ok: false, error: "That code isn't right. Check it and try again." });
  fireEvent.changeText(api.getByTestId('forgot-code'), '000000');
  fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'Str0ng#Pass');
  fireEvent.press(api.getByTestId('forgot-submit'));
  expect(await api.findByText(/code isn.t right/i)).toBeTruthy();
  expect(api.getByTestId('forgot-confirm-form')).toBeTruthy();
});

it('Back to sign in returns to the sign-in form', async () => {
  const api = render(<Login />);
  fireEvent.press(api.getByTestId('login-forgot'));
  fireEvent.press(api.getByTestId('forgot-back'));
  await waitFor(() => expect(api.getByTestId('signin-form')).toBeTruthy());
});
