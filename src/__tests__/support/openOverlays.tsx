// WHIT-670 — draw <Overlays/> over the real query hooks the way the app opens a pop-up: the tab
// screens underneath have already loaded what the pop-up reads, then the sheet opens. The add-rule
// form fills itself only once, on open (useSheetDraft's lazy init), so opening it before the rules
// and categories have loaded would fill it from empty lists.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { act } from '@testing-library/react-native';
import { Overlays } from '../../components/Overlays';
import { useCategories, useRecentTransactionsScreenData, useRulesScreenData, useTransactionResolver } from '../../queries';
import { renderWithQueries, WithQueries } from './renderWithQueries';

// Stands in for the tab screens under the overlay layer.
function ScreensUnderneath() {
  useCategories();
  useRulesScreenData();
  useTransactionResolver();
  useRecentTransactionsScreenData();
  return null;
}

export function OverlaysOverScreens() {
  return (
    <>
      <ScreensUnderneath />
      <Overlays />
    </>
  );
}

/** For a rerender: the same tree, re-wrapped in the query provider. */
export const overlaysTree = () => (
  <WithQueries>
    <OverlaysOverScreens />
  </WithQueries>
);

/**
 * Load the screens with no sheet open, then open `state.sheet`. `setState` points the suite's
 * mocked useAppContext at the state it is given.
 */
export async function openOverlays<S extends { sheet?: unknown }>(state: S, setState: (next: S) => void) {
  setState({ ...state, sheet: null });
  const view = await renderWithQueries(<OverlaysOverScreens />);
  setState(state);
  await act(async () => view.rerender(overlaysTree()));
  return view;
}
