// WHIT-674 — the one React Query test client every screen test builds from. Each test gets a
// fresh client (no shared cache); staleTime and retry are the only settings tests vary.
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from '@testing-library/react-native';
import { jest } from '@jest/globals';

type ClientOptions = { staleTime?: number; retry?: boolean | number };

export function makeClient({ staleTime = 60_000, retry = false }: ClientOptions = {}) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime, gcTime: Infinity } } });
}

export const wrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);

export const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

export function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((call: unknown[]) => (call[0] as { queryKey: string[] }).queryKey[0]);
}

export const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
