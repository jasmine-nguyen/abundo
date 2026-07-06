// WHIT-195 CHARACTERIZATION — the flagged NEW-badge divergence on a refetch.
// The store keeps a freshly-created rule's client-only isNew:true (the "NEW" badge) until a
// remount/re-auth. The ['rules'] query holds isNew:true only from the optimistic mirror; ANY
// refetch remaps the server payload via selectRules — which hard-codes isNew:false — so the
// badge CLEARS on the next ['rules'] refetch, earlier than the old store did. In production
// that refetch is what a stale focus-refetch (refetchStale, wired in app/rules.tsx) triggers
// once the 45s window has elapsed; here we drive the refetch directly to pin the REMAP
// consequence (selectRules → isNew:false). This test PINS that behaviour so the decision is
// visible: if the badge should survive a refetch, selectRules/this test must change. (Not a
// bug the code violates — a documented UX consequence of the "no ['rules'] invalidate".)
// The refetchStale focus SEAM itself (stale-gate under real timers) is out of scope here —
// tracked separately; this locks only the remap-clears-the-badge outcome.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Rule } from '../context';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockListEnrichments = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({ listEnrichments: () => mockListEnrichments() }));

import { useRulesScreenData, rulesKey } from '../queries';

// The server row for e1 carries NO isNew (server never sends it) — selectRules maps it to false.
const SERVER = [{ id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' }];
// The cache after an optimistic create: the same rule but flagged NEW (badge showing).
const CACHED_NEW: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' };

beforeEach(() => { mockListEnrichments.mockReset().mockResolvedValue(SERVER); });

it('a rules-query refetch remaps via selectRules and CLEARS the NEW badge (isNew:true → false)', async () => {
  // staleTime Infinity so mounting over the seeded cache does NOT auto-refetch — we control
  // exactly when the refetch happens.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData<Rule[]>([...rulesKey], [CACHED_NEW]); // as if saveManualRule just mirrored it in

  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useRulesScreenData(), { wrapper });

  // Before the refetch: the badge is present (the mirror's isNew survived).
  expect(result.current.rules[0].isNew).toBe(true);

  // Drive the refetch of the active ['rules'] observer — in the app this is what a stale
  // focus-refetch fires. invalidateQueries awaits its own auto-refetch of the mounted query.
  await act(async () => { await client.invalidateQueries({ queryKey: [...rulesKey] }); });

  // The refetch remapped the server payload → isNew:false → the "NEW" badge is gone.
  await waitFor(() => expect(result.current.rules[0].isNew).toBe(false));
  expect(mockListEnrichments).toHaveBeenCalledTimes(1);
});
