// ABU-113 — on a wide screen (the iPhone Duo's inner screen) Insights and every full-screen page sit
// in a centred column of readable width; the screen edges' safe insets shrink by the gutter beside
// the column. Narrow screens are unchanged. The root stack wraps every page but the tabs and the
// index in that column.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Dimensions, View } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { styleOf } from './support/layout';
import { withInsets, DUO_SIDEWAYS_INSETS } from './support/safeAreaMock';
import { ReadableColumn, stackScreenLayout } from '../components/ReadableColumn';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));

// The unfolded Duo held upright is about 626pt wide; a 560pt column leaves a 33pt gutter each side.
const DUO_UPRIGHT_WIDTH = 626;

function setWindowWidth(width: number) {
  Dimensions.set({ window: { width, height: 900, scale: 3, fontScale: 1 } });
}

let seen: { left: number; right: number } | undefined;
function Probe() {
  const { left, right } = useSafeAreaInsets();
  seen = { left, right };
  return <View testID="page" />;
}

beforeEach(() => {
  seen = undefined;
  mockWide = true;
  setWindowWidth(DUO_UPRIGHT_WIDTH);
});

describe('ReadableColumn', () => {
  it('wide: centres the page in a capped column and trims the side insets by the gutter', async () => {
    await render(withInsets(DUO_SIDEWAYS_INSETS, <ReadableColumn><Probe /></ReadableColumn>));

    const column = screen.getByTestId('page').parent!;
    expect(styleOf(column).maxWidth).toBe(560);
    expect(styleOf(column.parent!).alignItems).toBe('center');
    expect(seen).toEqual({ left: 44 - 33, right: 59 - 33 });
  });

  it('narrow: the page fills the width with its insets unchanged', async () => {
    mockWide = false;
    setWindowWidth(390);
    await render(withInsets(DUO_SIDEWAYS_INSETS, <ReadableColumn><Probe /></ReadableColumn>));

    const column = screen.getByTestId('page').parent!;
    expect(styleOf(column).maxWidth).toBeUndefined();
    expect(styleOf(column.parent!).alignItems).not.toBe('center');
    expect(seen).toEqual({ left: 44, right: 59 });
  });
});

describe('stackScreenLayout', () => {
  it.each([
    ['(tabs)', false],
    ['index', false],
    ['budget/edit', true],
    ['milestone', true],
    ['category/[id]', true],
  ])('route %s wrapped in the readable column: %s', async (name, wrapped) => {
    const children = <View testID="page" />;
    const layout = stackScreenLayout({ route: { name }, children });

    if (!wrapped) {
      expect(layout).toBe(children);
      return;
    }
    await render(layout);
    expect(styleOf(screen.getByTestId('page').parent!).maxWidth).toBe(560);
  });
});
