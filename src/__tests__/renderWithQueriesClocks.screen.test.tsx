// WHIT-695 (qa): the draw tools' redraw flush must pick the right tick for each kind of clock —
// real timers, a date-only fake (pinToday), and Jest's legacy fake timers.
import { it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { screen } from '@testing-library/react-native';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../queryClient';
import { renderWithQueries, refreshInAct, useTestQueryClient } from './support/renderWithQueries';
import { pinToday } from './support/clock';

useTestQueryClient();

const GREETING_KEY = ['whit-695-clocks'];

function Greeting() {
  const { data } = useQuery({ queryKey: GREETING_KEY, queryFn: () => Promise.resolve('Loaded greeting') });
  return <Text>{data ?? 'Loading greeting'}</Text>;
}

afterEach(() => {
  jest.useRealTimers();
});

// [A1] (P0) A date-only fake clock keeps the real tick: setTimeout is real, so advancing the fake
// clock would flush nothing and the update below would never reach the screen.
it('[A1] on a date-only fake clock (pinToday) a cache write reaches the screen', async () => {
  pinToday(new Date(2026, 6, 11));
  await renderWithQueries(<Greeting />);
  expect(screen.getByText('Loaded greeting')).toBeTruthy();

  await refreshInAct(() => queryClient.setQueryData(GREETING_KEY, 'Updated greeting'));
  expect(screen.getByText('Updated greeting')).toBeTruthy();
});

// [A2] (P1) Legacy fake timers mock setTimeout without a `clock`; the real-tick yield would hang there.
it('[A2] on legacy fake timers the draw and a cache write both land without hanging', async () => {
  jest.useFakeTimers({ legacyFakeTimers: true });
  await renderWithQueries(<Greeting />);
  expect(screen.getByText('Loaded greeting')).toBeTruthy();

  await refreshInAct(() => queryClient.setQueryData(GREETING_KEY, 'Updated greeting'));
  expect(screen.getByText('Updated greeting')).toBeTruthy();
}, 3000);

// [A3] (P0) Real timers: a cache write flushed by refreshInAct is on screen straight after.
it('[A3] on real timers a cache write reaches the screen straight after refreshInAct', async () => {
  await renderWithQueries(<Greeting />);
  await refreshInAct(() => queryClient.setQueryData(GREETING_KEY, 'Updated greeting'));
  expect(screen.getByText('Updated greeting')).toBeTruthy();
});
