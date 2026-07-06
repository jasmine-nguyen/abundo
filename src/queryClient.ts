// WHIT-188: the shared TanStack Query client for the app's server reads — the first
// piece of the data-loading redesign (see the WHIT-187 epic). A `makeQueryClient()`
// factory so each test spins a fresh, isolated cache; a module singleton
// (`queryClient`) mounted once in app/_layout.tsx for the running app.
import { QueryClient } from '@tanstack/react-query';

// Errors that mean "this session can't make authed reads" — retrying them just
// hammers a signed-out / locked / expired session. `authHeaders()` throws
// "Not signed in" (src/api.ts) before a session exists, and the API Gateway JWT
// authorizer answers a bad/expired token with 401/403. The `enabled` auth gate on
// each query already stops the first case; this is belt-and-braces for a token that
// expires mid-session.
function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Not signed in' || /\b40[13]\b/.test(message);
}

// A transient 5xx / network blip is retried a few times with exponential backoff so a
// read self-heals instead of stranding a "couldn't load" banner (the WHIT-185 bug).
const RETRY_LIMIT = 3;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => !isAuthError(error) && failureCount < RETRY_LIMIT,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000), // 1s, 2s, 4s … capped 30s
        staleTime: 45_000, // data stays "fresh" for 45s before a background revalidate
        gcTime: 5 * 60_000, // keep unused cache 5 min so a tab revisit renders instantly
        refetchOnReconnect: true,
      },
    },
  });
}

// The app singleton — one cache for the whole session. Tests use makeQueryClient()
// (or their own client) so cases never share state.
export const queryClient = makeQueryClient();
