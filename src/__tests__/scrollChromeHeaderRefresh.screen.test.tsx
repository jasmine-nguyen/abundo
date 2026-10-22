// WHIT-814 — ScrollChromeHeader builds the pull-to-refresh spinner itself from `refreshing` /
// `onRefresh`, wired straight through to the screen.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { pullControl } from './support/pull';
import { render } from '@testing-library/react-native';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

it('with onRefresh, builds a spinner that passes refreshing through', async () => {
  const onRefresh = jest.fn();
  const r = await render(
    <ScrollChromeHeader title="Goals" refreshing onRefresh={onRefresh}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const spinner = pullControl();
  expect(spinner.props.refreshing).toBe(true);
  spinner.props.onRefresh();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
