// WHIT-773 — the shared money box (Loan + Goal edit) and the shared equity card (Milestone + Mortgage).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { routerSpies, resetRouter } from './support/routerMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { MoneyField } from '../components/MoneyField';
import { EquityCard, AddLoanDetailsPrompt } from '../components/EquityCard';

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

  it('equity card shows its heading, and the add-loan-details button opens the loan form', () => {
    render(
      <EquityCard>
        <AddLoanDetailsPrompt />
      </EquityCard>,
    );

    expect(screen.getByText('Equity for your next place')).toBeTruthy();
    expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
    expect(
      screen.getByText("Add your home's value to see how much equity you could unlock toward your next place."),
    ).toBeTruthy();

    fireEvent.press(screen.getByText('Add loan details →'));
    expect(routerSpies.push).toHaveBeenCalledWith('/loan');
  });
});
