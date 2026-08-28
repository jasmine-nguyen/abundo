// google-signin-error-feedback — GAP: the belt-and-braces catch in withGoogle.
// signInWithGoogle is documented to NEVER throw, but app/index.tsx still guards it.
// If it ever DOES reject, the screen must show a friendly message, clear the busy
// state (button label back from "Connecting…"), and not navigate. The existing
// loginScreen tests only cover resolved {ok:...} shapes, never a rejection.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const mockSignInWithPassword = jest.fn<(e: string, p: string) => Promise<unknown>>();
const mockSignInWithGoogle = jest.fn<() => Promise<import('../auth').OAuthSignInResult>>();
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

// [A12] signInWithGoogle rejects (should never happen) → the outer catch shows the
// belt-and-braces message, clears busy, no navigation.
it('a thrown Google sign-in shows "Something went wrong", clears busy, no nav', async () => {
  mockSignInWithGoogle.mockRejectedValue(new Error('unexpected throw'));
  const { getByTestId, findByText, queryByText } = render(<Login />);
  fireEvent.press(getByTestId('login-google'));
  expect(await findByText('Something went wrong. Please try again.')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
  // Busy cleared: the button label is back to its idle text, not "Connecting…".
  await waitFor(() => expect(getByTestId('login-google')).toHaveTextContent('Continue with Google'));
  expect(queryByText('Connecting…')).toBeNull();
});

// [A13] a genuine failure with an error message clears busy too (label returns to idle).
it('a failed Google sign-in clears the busy label back to "Continue with Google"', async () => {
  mockSignInWithGoogle.mockResolvedValue({ ok: false, error: "Couldn't complete Google sign-in. Please try again." });
  const { getByTestId, findByText } = render(<Login />);
  fireEvent.press(getByTestId('login-google'));
  expect(await findByText("Couldn't complete Google sign-in. Please try again.")).toBeTruthy();
  await waitFor(() => expect(getByTestId('login-google')).toHaveTextContent('Continue with Google'));
});
