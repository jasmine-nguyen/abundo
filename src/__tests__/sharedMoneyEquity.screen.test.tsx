// WHIT-773 — the shared money box (Loan + Goal edit) and the shared equity card (Milestone + Mortgage).
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { EQUITY_TEASER } from './support/goalsScreen';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { MoneyField } from '../components/MoneyField';
import { EquityCard, EquitySetupTeaser } from '../components/EquityCard';

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
    expect(screen.getByText(EQUITY_TEASER)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
