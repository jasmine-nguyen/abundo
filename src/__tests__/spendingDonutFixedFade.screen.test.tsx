// WHIT-759 — tapping a pie slice fades the others to fixed values: category slices to 0.55, the
// grey "Other" bucket to 0.85, whatever their colour. Literals on purpose, not imported constants,
// so the test can't agree with the code by construction.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut } from '../components/SpendingDonut';
import { opacityOf, slice } from './support/donut';

describe('SpendingDonut — unselected slices fade to one fixed value per kind', () => {
  it('user taps a slice: category peers of any colour fade to 0.55, the folded Other to 0.85, and tapping again restores all', () => {
    const slices = [
      slice('blue', '#7aa2f7', 40),
      slice('green', '#7FD49B', 30),
      slice('peach', '#E8A87C', 20),
      slice('purple', '#bb9af7', 15),
      slice('pink', '#f98f98', 10),
      slice('tiny1', '#4ccda3', 2),
      slice('tiny2', '#d2ae45', 1),
    ]; // 7 positive, cap 6 → tiny1 + tiny2 fold into __other__
    render(<SpendingDonut slices={slices} />);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));

    expect(opacityOf('blue')).toBeCloseTo(1);
    for (const id of ['green', 'peach', 'purple', 'pink']) {
      expect(opacityOf(id)).toBeCloseTo(0.55, 3);
    }
    expect(opacityOf('__other__')).toBeCloseTo(0.85, 3);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));

    for (const id of ['blue', 'green', 'peach', 'purple', 'pink', '__other__']) {
      expect(opacityOf(id)).toBeCloseTo(1);
    }
  });
});
