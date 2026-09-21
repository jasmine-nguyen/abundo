// WHIT-437: the server explains why it refused a write — "a category can have at most 50
// sub-categories" — and the app used to throw that away and say "Please try again", which for a
// permanent refusal is a lie. This module decides when the server's own words are safe to show.
//
// No imports on purpose: src/api.ts pulls in ./auth at load, so keeping these rules here lets the
// fast `logic` tests exercise them with no mocking at all.

export class ApiError extends Error {
  readonly status: number;
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null) {
    // BYTE-IDENTICAL to the old `API error: ${status}`. src/queryClient.ts matches /\b40[13]\b/
    // against this to suppress retries on an expired session, and ~99 assertions across the suite
    // pin the exact text. The reason goes in its OWN field — never fold it into the message, or a
    // server string containing "401" silently turns retries off.
    super(`API error: ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

// A reason longer than this is not something a 3.4-second toast can carry, and is more likely a
// stack trace than a sentence. Three real messages embed the category's id and nothing caps a
// category name, so a long name can push a GENUINE reason past this — hence truncate, never
// discard: a trimmed real reason still beats a fabricated "try again".
const MAX_REASON_CHARS = 160;

/** The server's own words, or null when there is nothing trustworthy to show. */
export function writeFailureReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;      // network, abort, "Not signed in"
  if (error.status < 400 || error.status >= 500) return null;  // our fault — retrying may work
  if (error.status === 401 || error.status === 403) return null;  // the auth gate owns these
  if (!error.serverMessage) return null;
  // Count WHOLE characters, not UTF-16 code units: a `.slice` boundary can fall between an
  // emoji's two surrogate halves and leave a lone surrogate that renders as `�` (WHIT-441).
  // Array.from splits on code points, so the cut always lands on a whole-character boundary.
  const chars = Array.from(error.serverMessage);
  if (chars.length <= MAX_REASON_CHARS) return error.serverMessage;
  return `${chars.slice(0, MAX_REASON_CHARS - 1).join('').trimEnd()}…`;
}

/** Give a clause a full stop unless it already ends in terminal punctuation. */
export function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * A complete standalone sentence for a toast, or the caller's generic fallback.
 *
 * Use this where the reason IS the whole message. Where it is folded into a longer line — the
 * category edit screen's summary toast — use writeFailureReason + endSentence instead, so the
 * reason is not capitalised mid-sentence.
 */
export function writeFailureMessage(error: unknown, fallback: string): string {
  const reason = writeFailureReason(error);
  if (reason === null) return fallback;
  return endSentence(reason[0].toUpperCase() + reason.slice(1));
}
