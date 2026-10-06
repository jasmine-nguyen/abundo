// WHIT-773 QA — adversarial checks on the shared money box and equity card, through the real
// Loan, Goal edit, Milestone and Mortgage screens as well as the components on their own.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, renderLoaded, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';

// One stub for every screen here: each reads only the writers it needs off it.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ saveLoanFacts: jest.fn(), saveGoal: jest.fn(), deleteGoal: jest.fn(), showToast: jest.fn() }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { MoneyField } from '../components/MoneyField';
import { EquityCard, EquityBody } from '../components/EquityCard';
import Loan from '../../app/loan';
import GoalEdit from '../../app/goal/edit';
import Milestone from '../../app/milestone';
import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

const styleOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);

describe('MoneyField on its own', () => {
  it('[A1] a suffix-only field shows the suffix and no prefix sign', () => {
    render(<MoneyField label="LVR" placeholder="e.g. 80" value="" onChangeText={() => {}} suffix="%" />);
    expect(screen.getByText('%')).toBeTruthy();
    expect(screen.queryByText('$')).toBeNull();
  });

  it('[A2] no hint is drawn when none is given (no empty hint line)', () => {
    const view = render(<MoneyField label="Amount" placeholder="e.g. 1" value="" onChangeText={() => {}} prefix="$" />);
    // Only the label and the sign: a stray empty hint <Text> would make this 3.
    expect(view.UNSAFE_getAllByType(Text)).toHaveLength(2);
  });

  it('[A3] the screen label style is used, and the outer style lands on the wrapper', () => {
    const view = render(
      <MoneyField label="Amount" labelStyle={{ fontSize: 99 }} style={{ marginBottom: 42 }} placeholder="e.g. 1" value="7" onChangeText={() => {}} />,
    );
    expect(styleOf('Amount').fontSize).toBe(99);
    expect(StyleSheet.flatten((view.toJSON() as ReactTestRendererJSON).props.style)).toEqual(
      expect.objectContaining({ marginBottom: 42 }),
    );
    expect(screen.getByPlaceholderText('e.g. 1').props.value).toBe('7');
    expect(screen.getByPlaceholderText('e.g. 1').props.inputMode).toBe('decimal');
  });
});

describe('EquityCard pieces on their own', () => {
  it('[A4] the right-hand slot (Mortgage % badge) shows beside the heading', () => {
    render(<EquityCard right={<Text>42%</Text>}><EquityBody>body</EquityBody></EquityCard>);
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('[A5] a false right slot (no target set) draws nothing extra', () => {
    const view = render(<EquityCard right={false}><EquityBody>body</EquityBody></EquityCard>);
    expect(view.UNSAFE_getAllByType(Text).map((t) => t.props.children)).toEqual([
      'Equity for your next place', 'Usable equity from your current home', 'body',
    ]);
  });
});

describe('equity card on the screens (drift fix)', () => {
  it('[A8] (P0) Milestone heading is 14.5pt and its subheading 12.5pt, like Mortgage', async () => {
    seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
    await renderWithQueries(<Milestone />);
    expect(styleOf('Equity for your next place').fontSize).toBe(14.5);
    expect(styleOf('Usable equity from your current home').fontSize).toBe(12.5);
  });

  it('[A9] (P0) Mortgage heading and subheading keep their 14.5 / 12.5pt size', async () => {
    seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
    await renderWithQueries(<Mortgage />);
    expect(styleOf('Equity for your next place').fontSize).toBe(14.5);
    expect(styleOf('Usable equity from your current home').fontSize).toBe(12.5);
  });

  it('[A10] (P0) Mortgage "Set deposit target →" still opens the loan form', async () => {
    seedGoal(server, { homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
    await renderWithQueries(<Mortgage />);
    fireEvent.press(screen.getByText('Set deposit target →'));
    expect(routerSpies.push).toHaveBeenCalledWith('/loan');
  });

  it('[A11] Mortgage % badge shows only when a deposit target is set', async () => {
    seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('50%')).toBeTruthy();
  });
});

describe('money box on the screens', () => {
  it('[A12] (P0) Loan form: four $ fields, two % fields, every hint, and its own 13.5pt label', async () => {
    server.seed('/loanfacts', LOAN_FACTS);
    await renderLoaded(<Loan />);
    // original, home value, scheduled, extra, deposit → 5 "$"; LVR + rate → 2 "%".
    expect(screen.getAllByText('$')).toHaveLength(5);
    expect(screen.getAllByText('%')).toHaveLength(2);
    expect(screen.getByText('What you first borrowed')).toBeTruthy();
    expect(screen.getByText('How much the bank lends against it — usually 80')).toBeTruthy();
    expect(screen.getByText('Optional — sets the target the equity card tracks toward.')).toBeTruthy();
    expect(styleOf('Original loan amount')).toEqual(expect.objectContaining({ fontSize: 13.5, fontWeight: '700' }));
  });

  it('[A13] (P0) Goal edit: amount fields keep the $ sign, the small caps label look and the hint', async () => {
    server.seed('/goals', []);
    server.seed('/transactions', []);
    server.seed('/accounts/balances', []);
    await renderWithQueries(<GoalEdit />);
    expect(styleOf('TARGET AMOUNT')).toEqual(expect.objectContaining({ fontSize: 12, letterSpacing: 0.3 }));
    expect(screen.getByText('What you want to save up to.')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    expect(screen.getByPlaceholderText('e.g. 10000').props.value).toBe('5000');
    expect(screen.getAllByText('$').length).toBeGreaterThanOrEqual(2);
  });
});
