// WHIT-456 (slice 2 of WHIT-451) — unit contract for support/routerMock's spy + params
// primitives. The screen adopter (budgetsQuery) already pins routerSpies.push + run-on-mount
// useFocusEffect through a real render; this suite pins the surface it DOESN'T touch:
//   [A10] useRouter() returns the object routerSpies points at (back/replace/dismissAll wired)
//   [A11] setParams round-trips through useLocalSearchParams
//   [A12] resetRouter resets params (not just the spies)
//   [A13] resetRouter clears recorded spy calls
import { describe, it, expect, beforeEach } from '@jest/globals';
import { routerSpies, setParams, resetRouter, routerMockModule } from './routerMock';

beforeEach(() => resetRouter());

describe('WHIT-456 routerMock contract', () => {
  it('[A10] useRouter() returns the same router the spies reference — back/replace/dismissAll wired', () => {
    const mod = routerMockModule();
    const router = mod.useRouter();
    router.back();
    router.replace('/settings');
    router.dismissAll();
    expect(routerSpies.back).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith('/settings');
    expect(routerSpies.dismissAll).toHaveBeenCalledTimes(1);
    // and the object identity is genuinely shared, not a copy
    expect(router).toBe(routerSpies);
  });

  it('[A11] setParams round-trips through useLocalSearchParams', () => {
    const mod = routerMockModule();
    setParams({ id: 'g1', mode: 'edit' });
    expect(mod.useLocalSearchParams()).toEqual({ id: 'g1', mode: 'edit' });
  });

  it('[A12] resetRouter resets params back to empty (not just the spies)', () => {
    const mod = routerMockModule();
    setParams({ id: 'g1' });
    resetRouter();
    expect(mod.useLocalSearchParams()).toEqual({});
  });

  it('[A13] resetRouter clears recorded spy calls', () => {
    routerSpies.push('/budget/pick');
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
    resetRouter();
    expect(routerSpies.push).not.toHaveBeenCalled();
  });
});
