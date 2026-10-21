// Swap the global fetch for a jest.fn and return it, so a suite can script responses and read the calls.
import { jest } from '@jest/globals';

type FetchFake = (url: string, init?: RequestInit) => Promise<unknown>;

export function stubFetch(impl?: FetchFake) {
  const fetch = jest.fn<FetchFake>(impl);
  (globalThis as unknown as { fetch: unknown }).fetch = fetch;
  return fetch;
}
