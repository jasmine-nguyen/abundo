// WHIT-774 QA: MoneyField's new optional boxStyle and testID props. Callers that pass neither
// (goal edit, loan form) must keep the shared C.card box; boxStyle only overrides what it names.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { MoneyField } from '../components/MoneyField';
import { C } from '../theme';
import { styleOf } from './support/layout';

const boxStyleOf = (placeholder: string) => styleOf(screen.getByPlaceholderText(placeholder).parent!.parent!);

describe('MoneyField boxStyle + testID', () => {
  it('[A1] with no boxStyle the box keeps the shared C.card background', () => {
    render(<MoneyField label="Amount" placeholder="e.g. 1" value="" onChangeText={() => {}} prefix="$" />);
    expect(boxStyleOf('e.g. 1').backgroundColor).toBe(C.card);
  });

  it('[A2] boxStyle overrides only what it names; the rest of the box is kept', () => {
    render(<MoneyField label="Amount" placeholder="e.g. 1" value="" onChangeText={() => {}} prefix="$" boxStyle={{ backgroundColor: C.bg }} />);
    expect(boxStyleOf('e.g. 1')).toEqual(expect.objectContaining({
      backgroundColor: C.bg, flexDirection: 'row', borderColor: C.hairline, borderRadius: 14, height: 50,
    }));
  });

  it('[A3] testID tags the typing box itself, so typing through it reaches onChangeText', () => {
    const onChangeText = jest.fn();
    render(<MoneyField label="Amount" placeholder="e.g. 1" value="" onChangeText={onChangeText} testID="amount-box" />);
    const input = screen.getByTestId('amount-box');
    expect(input.props.placeholder).toBe('e.g. 1');
    fireEvent.changeText(input, '42');
    expect(onChangeText).toHaveBeenCalledWith('42');
  });
});
