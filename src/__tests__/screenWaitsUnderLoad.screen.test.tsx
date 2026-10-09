// WHIT-842: under the full parallel screen run, a fetch → redraw can take longer than RNTL's 1s
// default wait, and settle() could return between a read ending and its redraw. The shared setup
// gives every wait more room, and settle() leaves the screen redrawn.
import { it, expect } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { screen, waitFor } from '@testing-library/react-native';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../queryClient';
import { drawHeld, settle, useTestQueryClient } from './support/renderWithQueries';

useTestQueryClient();

const GREETING_KEY = ['whit-842-greeting'];

it('settle() returns with a finished read already drawn on screen', async () => {
  let release: (value: string) => void = () => undefined;
  const reply = new Promise<string>((resolve) => { release = resolve; });
  function Greeting() {
    const { data } = useQuery({ queryKey: GREETING_KEY, queryFn: () => reply });
    return <Text>{data ?? 'Loading greeting'}</Text>;
  }
  drawHeld(<Greeting />);

  release('Loaded greeting');
  await queryClient.getQueryCache().find({ queryKey: GREETING_KEY })!.promise;
  await settle();

  expect(screen.getByText('Loaded greeting')).toBeTruthy();
});

it('a shared wait keeps polling past the old 1s limit without a per-call timeout', async () => {
  const start = Date.now();
  await waitFor(() => expect(Date.now() - start).toBeGreaterThanOrEqual(1500));
});
