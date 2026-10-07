// WHIT-735 QA — the top card's one rule (cents only when the amount has them) on the cases the
// build's tests don't draw (under budget with cents, over budget in whole dollars, a budget total
// with cents), and the five tab labels at 11pt or more, still shrinking to fit.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { styleOf } from './support/layout';

jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider } from '../chat/ChatContext';
import { resetRouter } from './support/routerMock';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { tabBarProps } from './support/tabBar';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE } from './support/categories';
import { showBudgets, heroTotals } from './support/budgetsScreen';
import { MINUS } from '../theme';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

describe('WHIT-735 QA: top card amounts', () => {
  // [A3] (P0) under budget with cents → no minus, cents kept, "Left to spend".
  it('[A3] under budget with cents shows $249.75 left, Spent $50.25 · Budget $300', async () => {
    await showBudgets(server, {
      coffee: { target: 200, posted: 50.25, pending: 0 },
      groceries: { target: 100, posted: 0, pending: 0 },
    });

    expect(screen.getByText('$249.75')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText(/^−/)).toBeNull();
    expect(heroTotals()).toMatchObject({ spent: '$50.25', budget: '$300' });
  });

  // [A4] (P0) over budget by whole dollars → a real minus, no ".00".
  it('[A4] over budget by whole dollars shows −$100, not −$100.00', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 200, pending: 0 } }, { categories: [COFFEE] });

    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$200', budget: '$100' });
  });

  // [A5] (P1) a positive budget total with cents keeps them (was rounded to whole dollars).
  it('[A5] a budget total of $200.50 shows its cents', async () => {
    await showBudgets(server, {
      coffee: { target: 200, posted: 10, pending: 0, rollover: true, carryover: 0.5, available: 200.5 },
    }, { categories: [COFFEE] });

    expect(heroTotals().budget).toBe('$200.50');
  });
});

const barProps = tabBarProps();

// [A6] (P0) every tab label is at least Apple's 11pt, and still shrinks to fit on one line.
it('[A6] all five tab labels are 11pt or more and keep their one-line shrink-to-fit', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);

  for (const label of ['Budgets', 'Transactions', 'Accounts', 'Insights', 'Goals']) {
    const text = screen.getByText(label);
    expect(styleOf(text).fontSize).toBeGreaterThanOrEqual(11);
    expect(text.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, maxFontSizeMultiplier: 1.2 });
  }
});
