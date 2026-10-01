// WHIT-677 QA — refreshInAct lands the query library's setTimeout(0) observer flush inside act,
// for both a sync cache write and an async refresh, so the hook sees the new data with no waitFor
// and React logs no act warning.
import { it, expect, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useQuery } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { refreshInAct } from './support/renderWithQueries';

function mountQuery(fetchValue: () => Promise<string>) {
  const client = makeClient();
  const view = renderHook(() => useQuery({ queryKey: ['k'], queryFn: fetchValue }), { wrapper: wrapper(client) });
  return { client, view };
}

function actWarnings(spy: jest.SpiedFunction<typeof console.error>) {
  return spy.mock.calls.filter((call) => String(call[0]).includes('not wrapped in act'));
}

// [A1]
it('a sync setQueryData through refreshInAct reaches the observer before it returns, with no act warning', async () => {
  const { client, view } = mountQuery(async () => 'first');
  await waitFor(() => expect(view.result.current.data).toBe('first'));
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  await refreshInAct(() => client.setQueryData(['k'], 'written'));

  expect(view.result.current.data).toBe('written');
  expect(actWarnings(errorSpy)).toEqual([]);
  errorSpy.mockRestore();
});

// [A2]
it('an async invalidate through refreshInAct reaches the observer before it returns', async () => {
  let value = 'first';
  const { client, view } = mountQuery(async () => value);
  await waitFor(() => expect(view.result.current.data).toBe('first'));
  value = 'refetched';

  await refreshInAct(() => client.invalidateQueries({ queryKey: ['k'] }));

  expect(view.result.current.data).toBe('refetched');
});
