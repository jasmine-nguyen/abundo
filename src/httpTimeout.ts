/**
 * Read a promise under a timeout, rejecting if it hasn't settled in `timeoutMs`. Response-body
 * reads run AFTER a fetch abort timer has been cleared (an AbortController bounds only the headers,
 * then is released once they resolve), so without this a response whose body never finishes
 * streaming hangs the read — and the writer / query / token refresh behind it — spinning the UI
 * forever. Shared by the API success + error readers (WHIT-441, WHIT-448) and the token refresh.
 *
 * On timeout the still-pending read is left with a no-op catch so an orphaned rejection can't
 * surface as an unhandled rejection (which flakes the RN runtime and jest); a read that rejects
 * BEFORE the timer still propagates its own error to the caller.
 */
export function withBodyTimeout<T>(read: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("body read timed out")), timeoutMs);
  });
  read.catch(() => {});   // the losing arm's rejection is expected; swallow it, don't leak it
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}
