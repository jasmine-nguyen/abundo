import { jest } from '@jest/globals';
import type React from 'react';
import type { TabBar } from '../../../app/(tabs)/_layout';

export const TAB_ROUTES = ['budgets', 'transactions', 'accounts', 'insights', 'goals'];

export function tabBarProps(routes: string[] = TAB_ROUTES): React.ComponentProps<typeof TabBar> {
  return {
    state: { index: 0, routes: routes.map((name) => ({ key: name, name })) },
    navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
  };
}
