// WHIT-285 — gaps for the two-field OBJECT collapse + guarded alias setters the refactor
// introduced in AddRuleSheet (mirrored in GoalBalanceSheet). The lock-survival suites
// (overlaysSheetDraft*.screen.test.tsx) pin that BOTH fields survive a lock [A5][A6]; they do
// NOT pin the seam the collapse created: that an alias setter MERGES rather than clobbers its
// sibling field, and that the guarded bailout makes a no-op setter a REAL no-op — no state
// churn, no extra persist write. We mount AddRuleSheet over a Map-backed draft store (the
// AddRuleSheet.screen.test.tsx mock pattern) so we can read the RAW persisted draft object and
// COUNT writes — neither is observable through the full-provider lock harness.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const RULE_INPUT = 'e.g. NETFLIX';
const DRAFT_KEY = 'addrule:new'; // no ruleId → the new-rule key

// A real Map behind spies, so we can both read the persisted draft and count writes.
const store = new Map<string, unknown>();
const readSheetDraft = jest.fn((key: string): unknown => store.get(key));
const writeSheetDraft = jest.fn((key: string, value: unknown) => { store.set(key, value); });

const fns = {
  updateRule: jest.fn(), saveManualRule: jest.fn(), setSheet: jest.fn(),
  dismissNotif: jest.fn(), readSheetDraft, writeSheetDraft,
};

function newRuleState(): AppContext {
  return {
    sheet: { mode: 'addrule' }, // no ruleId → key `addrule:new`, no editing prefill
    toast: null, notif: null,
    rules: [],
    categories: [
      { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
      { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
    ],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => {
  store.clear();
  readSheetDraft.mockClear();
  writeSheetDraft.mockClear();
  mockState = newRuleState();
});

describe('WHIT-285 — AddRule two-field object collapse + guarded alias setters', () => {
  // [B1] The object-merge: changing categoryId must keep the sibling `pattern` in the SAME draft.
  // A non-merge setter (setDraft({ categoryId: value })) would drop `pattern` from the persisted
  // object — this pins {...prev, categoryId: value}.
  it('[B1] selecting a category after typing a pattern persists BOTH fields (merge, no clobber)', () => {
    render(<Overlays />);
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    fireEvent.press(screen.getByText('Groceries'));

    expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'SPOTIFY', categoryId: 'groceries' });
    // the live field still reflects it — the collapse didn't decouple state from the input
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
  });

  // [B2] The reverse merge: typing a pattern AFTER selecting a category must not clobber the
  // categoryId. Order-independence of the object-merge.
  it('[B2] typing a pattern after selecting a category keeps the categoryId (merge both ways)', () => {
    render(<Overlays />);
    fireEvent.press(screen.getByText('Subscriptions'));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'NETFLIX');

    expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'NETFLIX', categoryId: 'subs' });
  });

  // [B3] The guarded bailout: re-tapping the ALREADY-selected pill returns `prev` unchanged, so
  // React bails the update and the persist effect never re-fires. Dropping the
  // `prev.categoryId === value` guard would re-render with a new (equal) object and write again.
  it('[B3] re-tapping the already-selected category is a no-op — no extra write, pattern untouched', () => {
    render(<Overlays />);
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    fireEvent.press(screen.getByText('Groceries')); // first selection → a real write

    const writesBefore = writeSheetDraft.mock.calls.length;
    const draftBefore = store.get(DRAFT_KEY);

    fireEvent.press(screen.getByText('Groceries')); // re-tap the SAME pill

    expect(writeSheetDraft.mock.calls.length).toBe(writesBefore); // no rewrite
    expect(store.get(DRAFT_KEY)).toBe(draftBefore);               // same reference, not a fresh equal object
    expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'SPOTIFY', categoryId: 'groceries' });
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY'); // sibling field intact
  });
});
