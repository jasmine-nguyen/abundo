// WHIT-695: the shared drawing tools wait for the query library's last redraw themselves, so a
// suite can read the screen straight after drawing — on a fake clock too, where that redraw's
// one-tick timer is otherwise held back.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { screen } from '@testing-library/react-native';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../queryClient';
import { renderWithQueries, renderLoaded, refreshInAct, useTestQueryClient } from './support/renderWithQueries';

useTestQueryClient();

const GREETING_KEY = ['whit-695-greeting'];

function Greeting() {
  const { data } = useQuery({ queryKey: GREETING_KEY, queryFn: () => Promise.resolve('Loaded greeting') });
  return <Text>{data ?? 'Loading greeting'}</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('renderWithQueries on a fake clock returns with the loaded data already on screen', async () => {
  await renderWithQueries(<Greeting />);

  expect(screen.getByText('Loaded greeting')).toBeTruthy();
  expect(screen.queryByText('Loading greeting')).toBeNull();
});

it('renderLoaded and refreshInAct on a fake clock both leave the screen redrawn with the latest data', async () => {
  await renderLoaded(<Greeting />);
  expect(screen.getByText('Loaded greeting')).toBeTruthy();

  await refreshInAct(() => queryClient.setQueryData(GREETING_KEY, 'Updated greeting'));

  expect(screen.getByText('Updated greeting')).toBeTruthy();
}, 3000);
