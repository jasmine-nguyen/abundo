// WHIT-711 QA — the shared header icon button keeps the exact look the four copies had
// (40x40, radius 12, tinted accentAlt fill, accentSoft glyph), and the gear keeps its 20pt glyph.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { HeaderIconButton } from '../components/ui';
import { SettingsButton } from '../components/SettingsButton';
import { C, tint } from '../theme';
import { styleOf } from './support/layout';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

function glyphs() {
  return screen.UNSAFE_root.findAll((node) => typeof node.props.xml === 'string' && node.props.width !== undefined);
}

// [A1]
it('draws a 40x40 rounded square filled with the tinted accent, icon centred', () => {
  render(<HeaderIconButton icon="plus" accessibilityLabel="Add budget" onPress={() => {}} />);
  const style = styleOf(screen.getByLabelText('Add budget'));
  expect(style).toMatchObject({
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: tint(C.accentAlt, 0.16), alignItems: 'center', justifyContent: 'center',
  });
});

// [A2]
it('draws the icon in the accentSoft colour', () => {
  render(<HeaderIconButton icon="plus" accessibilityLabel="Add goal" onPress={() => {}} />);
  const xml = glyphs()[0].props.xml as string;
  expect(xml).toContain(C.accentSoft);
});

// [A3]
it('the Settings gear keeps its 20pt glyph (not the 22 default)', () => {
  render(<SettingsButton />);
  const sizes = glyphs().map((node) => node.props.width);
  expect(sizes).toContain(20);
  expect(sizes).not.toContain(22);
});
