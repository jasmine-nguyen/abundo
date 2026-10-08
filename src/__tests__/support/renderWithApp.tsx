// WHIT-692 — draw a screen inside the REAL AppProvider (over the app's queryClient singleton), so
// its save/delete buttons run the real writers against the fake server. A probe inside the
// provider records every toast shown and the open sheet, for tests to read what the user sees.
// Call resetAppProbe() in beforeEach. (Not a *.test file, so the jest testMatch never runs it.)
import React, { useEffect } from 'react';
import { render } from '@testing-library/react-native';
import { AppProvider, useAppContext, type Sheet } from '../../context';
import { WithQueries, refreshInAct, settle } from './renderWithQueries';

let toasts: string[] = [];
let sheet: Sheet = null;

function AppProbe() {
  const app = useAppContext();
  useEffect(() => {
    if (app.toast !== null) toasts.push(app.toast);
  }, [app.toast]);
  sheet = app.sheet;
  return null;
}

export const shownToasts = (): string[] => toasts;
export const currentSheet = (): Sheet => sheet;

export function resetAppProbe() {
  toasts = [];
  sheet = null;
}

/** The bare AppProvider, for renderHook's `wrapper` option. */
export const appProviderWrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

export function WithApp({ children }: { children: React.ReactNode }) {
  return (
    <WithQueries>
      <AppProvider>
        <AppProbe />
        {children}
      </AppProvider>
    </WithQueries>
  );
}

/** Render inside the real AppProvider, wait until the first reads have settled, then flush their redraw. */
export async function renderWithApp(ui: React.ReactElement) {
  const view = render(<WithApp>{ui}</WithApp>);
  await settle();
  await refreshInAct(() => undefined);
  return view;
}
