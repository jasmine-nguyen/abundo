// WHIT-557 — [A43] the shared ConfirmPreviewSheet's preview-on-mount effect must NOT re-fire when
// the context re-renders for an unrelated reason (a toast landing, then auto-clearing 3.4s later).
// The wrapper hands the shell a useCallback-memoized `preview`; a stable identity keeps runPreview
// stable, so the mount effect runs exactly once. Regress the wrapper's `preview` to an inline arrow
// and every context re-render mints a new preview identity → the effect re-fires → a second
// previewNewRule call AND the sheet snaps back to its "Checking…" spinner mid-interaction (the exact
// WHIT-538 bug the memoisation exists to prevent). Not covered by addRulePreview(.gaps): those mount
// once and never re-render the provider underneath the settled preview card.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, act } from '@testing-library/react-native';
import type { AppContext, FilingResult, FilingTarget, FilingWhen } from '../context';
import type { ApplyRulesResult } from '../api';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  saveManualRule: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const CATEGORIES = [
  GROCERIES_TOP_RECORD,
];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 12, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 12 },
  byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 12, samples: ['COLES 1234 RICHMOND'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 12, createdRule: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// [A43] A context re-render (a toast landing) leaves the settled preview card in place and fires NO
// second preview. Fail-on-revert: change AddRuleConfirmSheet's `preview` from a useCallback to an
// inline arrow — the re-render re-fires the mount effect, previewNewRule is called twice, and the
// "add-rule-confirm-busy" spinner reappears (file button gone).
it('[A43] a context re-render does not re-fire the preview or snap back to the spinner', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  const sheet = { mode: 'addRuleConfirm', pattern: 'COLES', categoryId: 'groceries' } as const;
  server.seed('/categories', CATEGORIES);
  // The screens load first and the pop-up opens on the rerender, so that open is its only mount.
  const state = { sheet, toast: null, ...fns } as unknown as AppContext;
  const { rerender } = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {}); // let the mount-time preview resolve into the preview card

  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('add-rule-confirm-file')).toBeTruthy();

  // Simulate the provider re-rendering for an unrelated reason: a toast appears (new context value
  // identity), the SAME sheet object underneath. The memoized preview must hold.
  await act(async () => {
    mockState = { ...mockState, toast: 'Filed something elsewhere' } as unknown as AppContext;
    rerender(overlaysTree());
  });
  // ...and its auto-clear 3.4s later — a second re-render.
  await act(async () => {
    mockState = { ...mockState, toast: null } as unknown as AppContext;
    rerender(overlaysTree());
  });

  expect(fns.previewFiling).toHaveBeenCalledTimes(1);           // never re-fired
  expect(screen.getByTestId('add-rule-confirm-file')).toBeTruthy(); // still the preview card
  expect(screen.queryByTestId('add-rule-confirm-busy')).toBeNull(); // never snapped back to spinner
});
