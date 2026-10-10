// WHIT-846: the shared search box on Transactions and Rules. Clearing itself is covered on both
// screens (transactionsScreenStates / RulesScreen); this pins the clear button: hidden when empty,
// drawn with the icon set's close glyph (not a "✕" character), and a 44pt tap area.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { SearchField } from '../components/SearchField';
import { GLYPH } from '../icons';
import { styleOf } from './support/layout';

// The close glyph's path (its colour is inlined when drawn, so match the path, not the whole xml).
const CLOSE_PATH = GLYPH.close.match(/d="([^"]+)"/)![1];

const draw = (value: string) =>
  render(<SearchField value={value} onChangeText={jest.fn()} placeholder="Search" accessibilityLabel="Search" />);

// [A4]
it('shows a 44pt close-glyph clear button only once there is text', () => {
  draw('');
  expect(screen.queryByLabelText('Clear search')).toBeNull();

  draw('wool');
  const clear = screen.getByLabelText('Clear search');
  const box = styleOf(clear);
  expect(box.minWidth).toBeGreaterThanOrEqual(44);
  expect(box.minHeight).toBeGreaterThanOrEqual(44);
  expect(clear.findAll((n) => typeof n.props.xml === 'string' && n.props.xml.includes(CLOSE_PATH))).not.toHaveLength(0);
  expect(screen.queryByText('✕')).toBeNull();
});
