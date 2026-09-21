// WHIT-437 — when is the server's own wording safe to put on screen.
// The whole point of the card is that "Could not save category. Please try again." is a LIE for a
// permanent refusal, so these pin exactly which refusals we quote and which we still paper over.
import { describe, it, expect } from '@jest/globals';
import { ApiError, writeFailureReason, writeFailureMessage, endSentence } from '../apiError';

const CAP = 'a category can have at most 50 sub-categories';

describe('ApiError', () => {
  it('keeps the message byte-identical — queryClient and ~99 assertions read it', () => {
    const error = new ApiError(400, CAP);
    expect(error.message).toBe('API error: 400');
    expect(error.status).toBe(400);
    expect(error.serverMessage).toBe(CAP);
    expect(error.name).toBe('ApiError');
  });

  it('survives the babel class downlevel — both instanceof checks still hold', () => {
    const error = new ApiError(400, CAP);
    expect(error instanceof ApiError).toBe(true);
    expect(error instanceof Error).toBe(true);
    // the auth-retry gate matches this text, so it must still find the status
    expect(/\b40[13]\b/.test(new ApiError(403, null).message)).toBe(true);
  });
});

describe('writeFailureReason — which refusals we quote', () => {
  it('quotes a 4xx that explained itself', () => {
    expect(writeFailureReason(new ApiError(400, CAP))).toBe(CAP);
    expect(writeFailureReason(new ApiError(409, 'category already exists'))).toBe('category already exists');
    expect(writeFailureReason(new ApiError(404, 'category not found'))).toBe('category not found');
  });

  it('stays quiet where the reason is not ours to show', () => {
    expect(writeFailureReason(new ApiError(500, 'boom'))).toBeNull();          // our fault, retry may work
    expect(writeFailureReason(new ApiError(502, 'gateway'))).toBeNull();
    expect(writeFailureReason(new ApiError(401, 'nope'))).toBeNull();          // the auth gate owns these
    expect(writeFailureReason(new ApiError(403, 'nope'))).toBeNull();
    expect(writeFailureReason(new ApiError(400, null))).toBeNull();            // nothing to say
    expect(writeFailureReason(new ApiError(400, ''))).toBeNull();
  });

  it('stays quiet for anything that is not an ApiError', () => {
    expect(writeFailureReason(new Error('network'))).toBeNull();
    expect(writeFailureReason(new Error('Not signed in'))).toBeNull();
    expect(writeFailureReason('a bare string')).toBeNull();
    expect(writeFailureReason(undefined)).toBeNull();
  });
});

describe('writeFailureReason — the length bound truncates, never discards', () => {
  // Three real messages embed the category id and nothing caps a category name, so a long name
  // can push a GENUINE reason over the bound. Discarding it would hand back the exact bug on the
  // card; a trimmed real reason still beats a fabricated "try again".
  it('passes a 160-character reason through verbatim', () => {
    const exact = 'x'.repeat(160);
    expect(writeFailureReason(new ApiError(400, exact))).toBe(exact);
    expect(writeFailureReason(new ApiError(400, exact))).toHaveLength(160);
  });

  it('truncates one character over, and stays a prefix of the original', () => {
    const over = 'y'.repeat(161);
    const got = writeFailureReason(new ApiError(400, over));
    expect(got).toHaveLength(160);
    expect(got!.endsWith('…')).toBe(true);
    expect(over.startsWith(got!.slice(0, -1))).toBe(true);
  });

  it('truncates a realistic over-long detach message', () => {
    const long = `'${'a-very-long-category-name'.repeat(6)}' has 73 sub-categories — too many to detach in one write; move some out from under it first`;
    const got = writeFailureReason(new ApiError(400, long));
    expect(got).toHaveLength(160);
    expect(got!.startsWith("'a-very-long-category-name")).toBe(true);
  });
});

describe('writeFailureReason — WHIT-441: an emoji on the cut is never split into `�`', () => {
  // A lone surrogate — a high surrogate not followed by a low, or vice versa — is what renders as
  // the `�` replacement glyph. The old code-unit `.slice` could leave one; the fix must not.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('cuts on a whole-character boundary when an emoji straddles char 160', () => {
    // '😀' (U+1F600) is a surrogate pair sitting at code units 158–159 — exactly where the old
    // .slice(0, 159) cut, keeping the lone high surrogate. Total length 170 > 160 → truncates.
    const reason = 'a'.repeat(158) + '😀' + 'b'.repeat(10);
    const got = writeFailureReason(new ApiError(400, reason))!;
    expect(got.endsWith('…')).toBe(true);
    // Fail-on-revert: the old .slice leaves a lone high surrogate here → this matches → fails.
    expect(loneSurrogate.test(got)).toBe(false);
    expect(got).toContain('😀');   // the whole emoji survived, not half of it
  });

  it('counts an all-emoji reason by whole characters, not code units', () => {
    // 160 emoji = 320 UTF-16 code units but 160 CHARACTERS, so it is within the bound and passes
    // through verbatim. The old `.length` sees 320, truncates, and splits the last emoji.
    const allEmoji = '😀'.repeat(160);
    expect(writeFailureReason(new ApiError(400, allEmoji))).toBe(allEmoji);
  });
});

describe('writeFailureReason — boundary + lone-surrogate input (WHIT-441 item 2)', () => {
  // Pins the off-by-one at the 160-char boundary and the "never MINT a lone surrogate" contract.
  // A lone surrogate is the thing that renders as `�`; the truncation must never create one.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const MAX = 160;

  it('returns a reason of EXACTLY 160 characters verbatim (no ellipsis)', () => {
    // 159 ascii + one emoji = 160 CHARACTERS (161 UTF-16 code units). chars.length === 160 is the
    // <= MAX branch, so it must pass through untouched — the old `.length` (161) would truncate it.
    const exactly160 = 'a'.repeat(159) + '😀';
    expect(Array.from(exactly160).length).toBe(MAX);            // guard the fixture itself
    const got = writeFailureReason(new ApiError(400, exactly160))!;
    expect(got).toBe(exactly160);
    expect(got.endsWith('…')).toBe(false);
    expect(loneSurrogate.test(got)).toBe(false);
  });

  it('truncates at 161 characters and drops the whole boundary emoji, never half of it', () => {
    // 160 ascii + one emoji = 161 characters. slice(0, 159) keeps 159 chars, adds '…' → 160 chars,
    // and the emoji at index 159/160 is dropped ENTIRELY, so no lone surrogate survives.
    const over = 'a'.repeat(160) + '😀';
    expect(Array.from(over).length).toBe(161);
    const got = writeFailureReason(new ApiError(400, over))!;
    expect(got.endsWith('…')).toBe(true);
    expect(Array.from(got).length).toBe(MAX);                  // 159 kept + the ellipsis
    expect(loneSurrogate.test(got)).toBe(false);
    expect(got).not.toContain('😀');                           // the straddling emoji is gone whole
  });

  it('leaves a SHORT reason that already contains a lone surrogate untouched (does not sanitise)', () => {
    // The fix promises never to MINT a lone surrogate; it does not claim to repair one the server
    // sent. A short reason is under the cap, so it is returned verbatim, surrogate and all.
    const withLone = 'bad name \uD83D here';   // a bare high surrogate mid-string, length < 160
    expect(loneSurrogate.test(withLone)).toBe(true);
    expect(writeFailureReason(new ApiError(400, withLone))).toBe(withLone);
  });
});

describe('writeFailureMessage — a standalone sentence, or the fallback', () => {
  it('capitalises and terminates the reason', () => {
    expect(writeFailureMessage(new ApiError(400, CAP), 'fallback'))
      .toBe('A category can have at most 50 sub-categories.');
  });

  it('leaves punctuation that is already there alone', () => {
    expect(writeFailureMessage(new ApiError(400, 'already done.'), 'fallback')).toBe('Already done.');
    expect(writeFailureMessage(new ApiError(400, 'really?'), 'fallback')).toBe('Really?');
  });

  it('does not add a stop after the truncation ellipsis', () => {
    const got = writeFailureMessage(new ApiError(400, 'z'.repeat(200)), 'fallback');
    expect(got.endsWith('….')).toBe(false);
    expect(got.endsWith('…')).toBe(true);
  });

  it('does not mangle a message that opens with a quoted slug', () => {
    const detach = "'cafes-coffee' has 73 sub-categories — move some out from under it first";
    expect(writeFailureMessage(new ApiError(400, detach), 'fallback'))
      .toBe("'cafes-coffee' has 73 sub-categories — move some out from under it first.");
  });

  it('returns the caller fallback verbatim when there is no reason', () => {
    expect(writeFailureMessage(new Error('offline'), 'Could not save category. Please try again.'))
      .toBe('Could not save category. Please try again.');
  });
});

describe('endSentence', () => {
  it('adds a stop only when one is missing', () => {
    expect(endSentence('a clause')).toBe('a clause.');
    expect(endSentence('a clause.')).toBe('a clause.');
    expect(endSentence('really?')).toBe('really?');
    expect(endSentence('wow!')).toBe('wow!');
    expect(endSentence('trimmed…')).toBe('trimmed…');
  });
});
