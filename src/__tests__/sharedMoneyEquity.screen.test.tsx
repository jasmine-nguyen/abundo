// WHIT-773 — the shared money box (Loan + Goal edit) and the shared equity card (Milestone + Mortgage).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { MoneyField } from '../components/MoneyField';
import { EquityCard, EquitySetupTeaser } from '../components/EquityCard';

beforeEach(() => resetRouter());

describe('shared money box and equity card', () => {
  it('money box shows its label, sign and hint, uses the number keypad, and reports typing', () => {
    const onChangeText = jest.fn();
    render(
      <MoneyField
        label="Home value"
        hint="Your best guess is fine"
        placeholder="650000"
        value=""
        onChangeText={onChangeText}
        prefix="$"
      />,
    );

    expect(screen.getByText('Home value')).toBeTruthy();
    expect(screen.getByText('$')).toBeTruthy();
    expect(screen.getByText('Your best guess is fine')).toBeTruthy();

    const input = screen.getByPlaceholderText('650000');
    expect(input.props.keyboardType).toBe('decimal-pad');

    fireEvent.changeText(input, '720000');
    expect(onChangeText).toHaveBeenCalledWith('720000');
  });

  // WHIT-821: before set-up the equity card is a teaser with no button — set-up lives on the
  // Home loan screen's top card only.
  it('equity card shows its heading, and the set-up teaser has no button', () => {
    render(
      <EquityCard>
        <EquitySetupTeaser />
      </EquityCard>,
    );

    expect(screen.getByText('Equity for your next place')).toBeTruthy();
    expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
    expect(screen.getByText('Your usable equity will show here once your loan details are set up.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Add loan details →')).toBeNull();
  });
});
