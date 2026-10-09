// WHIT-814 — ScrollChromeHeader builds the pull-to-refresh spinner itself from `refreshing` /
// `onRefresh`: accent tint, offset below the header (WHIT-211), and no spinner at all for a
// screen with no pull action (Insights/Settings). Renders with the global zero safe-area
// insets, so headerHeight = HEADER_BODY_HEIGHT (58); the notch offset is covered by whit761.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { RefreshControl, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { C } from '../theme';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

it('with onRefresh, builds an accent spinner offset below the header that passes refreshing through', () => {
  const onRefresh = jest.fn();
  const r = render(
    <ScrollChromeHeader title="Goals" refreshing onRefresh={onRefresh}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const spinner = r.UNSAFE_getByType(RefreshControl);
  expect(spinner.props.tintColor).toBe(C.accent);
  expect(spinner.props.progressViewOffset).toBe(58);
  expect(spinner.props.refreshing).toBe(true);
  spinner.props.onRefresh();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('without onRefresh, renders no spinner', () => {
  const r = render(
    <ScrollChromeHeader title="Insights"><Text>body</Text></ScrollChromeHeader>,
  );
  expect(r.UNSAFE_queryByType(RefreshControl)).toBeNull();
});
