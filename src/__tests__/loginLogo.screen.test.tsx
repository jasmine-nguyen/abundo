// WHIT-796 — the login screen shows the same PNG tree mark as the lock screen
// (assets/abundo-tree-mark.png) instead of redrawing the logo in SVG.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../../src/auth', () => ({
  signInWithPassword: jest.fn(),
  signInWithGoogle: jest.fn(),
}));

import Login from '../../app/index';

it('renders the abundo tree mark PNG as the login logo', () => {
  const { getByTestId } = render(<Login />);
  const logo = getByTestId('login-logo');
  expect(logo.type).toBe('Image');
  expect(logo.props.source).toEqual(require('../../assets/abundo-tree-mark.png'));
});
