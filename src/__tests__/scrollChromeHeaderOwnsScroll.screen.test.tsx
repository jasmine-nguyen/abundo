// WHIT-761 — ScrollChromeHeader owns the scroll → nav-bars wiring and the header slide on its own.
// Rendered inside the real NavBarsProvider (reduce-motion on, so the bars jump instantly)
// with the global zero safe-area insets → headerHeight = 0 + 58.
import { it, expect } from '@jest/globals';
import React from 'react';
import { ScrollView, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { NavBarsProvider } from '../motion/NavBarsContext';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';
import { headerMotion, scrollTo } from './support/scrollChromeHeader';

function renderHeader() {
  return render(
    <NavBarsProvider reduceMotion>
      <ScrollChromeHeader title="Budgets">
        <Text>body</Text>
      </ScrollChromeHeader>
    </NavBarsProvider>,
  );
}

it('scrolling down slides the header up by its full height, scrolling back up shows it again', () => {
  const r = renderHeader();
  expect(r.UNSAFE_getAllByType(ScrollView)[0].props.scrollEventThrottle).toBe(16);
  expect(headerMotion(r)).toMatchObject({ translateY: 0, opacity: 1 });

  scrollTo(r, 200);
  expect(headerMotion(r)).toMatchObject({ translateY: -58, opacity: 0 });

  scrollTo(r, 400);
  expect(headerMotion(r)).toMatchObject({ translateY: -58, opacity: 0 });

  scrollTo(r, 100);
  expect(headerMotion(r)).toMatchObject({ translateY: 0, opacity: 1 });
});
