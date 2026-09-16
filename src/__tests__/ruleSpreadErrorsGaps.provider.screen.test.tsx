// WHIT-559 — adversarial GAP coverage for the spread error toasts + toRule mapping. The
// implementer's ruleSpreadErrors.provider.screen.test.tsx pins 422/409 on CREATE and a 422 on EDIT;
// rulesWrite.provider pins toRule mapping the captured bill (spread:true). The gaps here:
//   [A-E409] a 409 on the EDIT path (updateRule) → the specific "already has a spread rule" toast
//            (implementer only exercised 422 on edit) — a per-writer regression guard.
//   [A-TR0]  toRule maps a NON-spread rule cleanly: spread:false and the optional captured fields
//            stay undefined (no crash, no fabricated numbers).
//   [A-G0]   the spread copy is gated on the write REQUESTING spread — a 409/422 on a NON-spread
//            save keeps the generic toast (guards ruleWriteErrorMessage's `spread &&` gate).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext, toRule } from '../context';
import type { Rule } from '../context';
import { queryClient } from '../queryClient';
import { ApiError } from '../apiError';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const RULE_E1: Rule = { id: 'e1', pattern: 'ORIGIN', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const rules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
  queryClient.setQueryData(['categories'], [{ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 }]);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

// [A-E409] The 409 branch of ruleWriteErrorMessage must fire on the EDIT writer too, not just create.
it('[A-E409] a 409 on an edit that turns spread on shows the "already has a spread rule" copy and rolls back', async () => {
  mockApi.updateRule.mockRejectedValue(new ApiError(409, null));
  const result = mount();

  await act(async () => { await result.current.updateRule('e1', 'ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe('This category already has a spread rule');
  expect(rules()?.[0]).toEqual(RULE_E1);   // optimistic edit rolled back to the original
});

// [A-TR0] toRule maps a non-spread server rule without crashing and without inventing values:
// spread reflects the server's false, and the optional captured fields stay undefined.
it('[A-TR0] toRule maps a non-spread rule cleanly (spread:false, captured fields undefined)', () => {
  const mapped = toRule({ id: 'r1', value: 'ORIGIN', categoryId: 'subs', field: 'description', operator: 'contains', spread: false });
  expect(mapped.spread).toBe(false);
  expect(mapped.spreadAmount).toBeUndefined();
  expect(mapped.spreadGapDays).toBeUndefined();

  // And a server rule that omits spread entirely maps to undefined (optional, no crash).
  const bare = toRule({ id: 'r2', value: 'ORIGIN', categoryId: 'subs', field: 'description', operator: 'contains' });
  expect(bare.spread).toBeUndefined();
  expect(bare.spreadAmount).toBeUndefined();
});

// [A-G0] A 409 on a NON-spread save must NOT show the spread copy — the spread-specific messages are
// gated on the write actually requesting spread, so a future non-spread 409/422 stays generic.
// FAIL-ON-REVERT: drop the `spread &&` gate in ruleWriteErrorMessage and this shows the spread copy.
it('[A-G0] a 409 on a NON-spread save keeps the generic toast', async () => {
  mockApi.createRule.mockRejectedValue(new ApiError(409, null));
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false); });

  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});
