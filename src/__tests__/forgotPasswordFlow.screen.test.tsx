// WHIT-182 — the login screen's forgot-password flow: request a code → confirm it
// with a new password → back to sign in. ../../src/auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, fireEvent, waitFor, type RenderResult } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const mockRequestReset = jest.fn<(e: string) => Promise<unknown>>();
const mockConfirmReset = jest.fn<(e: string, c: string, p: string) => Promise<unknown>>();
jest.mock('../../src/auth', () => ({
  signInWithPassword: jest.fn(async () => ({ ok: true })),
  signInWithGoogle: jest.fn(async () => ({ ok: false })),
  completeNewPassword: jest.fn(async () => ({ ok: true })),
  requestPasswordReset: (...a: unknown[]) => mockRequestReset(...(a as [string])),
  confirmPasswordReset: (...a: unknown[]) => mockConfirmReset(...(a as [string, string, string])),
}));

import Login from '../../app/index';

// Open the forgot flow and get to the confirm form (code sent).
async function reachConfirm(api: RenderResult) {
  await fireEvent.press(api.getByTestId('login-forgot'));
  await fireEvent.changeText(api.getByTestId('forgot-email'), 'me@x.com');
  mockRequestReset.mockResolvedValue({ ok: true });
  await fireEvent.press(api.getByTestId('forgot-send'));
  await waitFor(() => expect(api.getByTestId('forgot-confirm-form')).toBeTruthy());
}

beforeEach(() => {
  resetRouter();
  mockRequestReset.mockReset();
  mockConfirmReset.mockReset();
});

it('a failed send stays on the request form with the error', async () => {
  const api = await render(<Login />);
  await fireEvent.press(api.getByTestId('login-forgot'));
  await fireEvent.changeText(api.getByTestId('forgot-email'), 'me@x.com');
  mockRequestReset.mockResolvedValue({ ok: false, error: 'Too many attempts. Try again in a bit.' });
  await fireEvent.press(api.getByTestId('forgot-send'));
  expect(await api.findByText(/too many/i)).toBeTruthy();
  expect(api.getByTestId('forgot-request-form')).toBeTruthy();
});

it('mismatched new passwords error without calling confirmPasswordReset', async () => {
  const api = await render(<Login />);
  await reachConfirm(api);
  await fireEvent.changeText(api.getByTestId('forgot-code'), '123456');
  await fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  await fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'different');
  await fireEvent.press(api.getByTestId('forgot-submit'));
  expect(await api.findByText(/don.t match/i)).toBeTruthy();
  expect(mockConfirmReset).not.toHaveBeenCalled();
});

it('a valid code + matching password resets and returns to sign in with a notice', async () => {
  const api = await render(<Login />);
  await reachConfirm(api);
  mockConfirmReset.mockResolvedValue({ ok: true });
  await fireEvent.changeText(api.getByTestId('forgot-code'), '123456');
  await fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  await fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'Str0ng#Pass');
  await fireEvent.press(api.getByTestId('forgot-submit'));

  await waitFor(() => expect(mockConfirmReset).toHaveBeenCalledWith('me@x.com', '123456', 'Str0ng#Pass'));
  await waitFor(() => expect(api.getByTestId('signin-form')).toBeTruthy());
  expect(await api.findByText(/password reset/i)).toBeTruthy(); // notice on the sign-in screen
  expect(routerSpies.replace).not.toHaveBeenCalled(); // reset does NOT auto-sign-in
});

it('a bad code stays on the confirm form with the error', async () => {
  const api = await render(<Login />);
  await reachConfirm(api);
  mockConfirmReset.mockResolvedValue({ ok: false, error: "That code isn't right. Check it and try again." });
  await fireEvent.changeText(api.getByTestId('forgot-code'), '000000');
  await fireEvent.changeText(api.getByTestId('forgot-new'), 'Str0ng#Pass');
  await fireEvent.changeText(api.getByTestId('forgot-confirm-pass'), 'Str0ng#Pass');
  await fireEvent.press(api.getByTestId('forgot-submit'));
  expect(await api.findByText(/code isn.t right/i)).toBeTruthy();
  expect(api.getByTestId('forgot-confirm-form')).toBeTruthy();
});
