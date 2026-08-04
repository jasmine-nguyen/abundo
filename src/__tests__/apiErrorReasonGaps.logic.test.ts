// WHIT-441 item 2 (gaps) — writeFailureReason's grapheme-safe truncation, at the exact 160-char
// boundary and with a pre-existing lone surrogate. The implementer's apiErrorReason suite covers
// the straddle + all-emoji cases; these pin the off-by-one boundary and the "don't make it worse"
// contract. Asserts against the REAL export, no re-implementation of the cut.
import { describe, it, expect } from '@jest/globals';
import { writeFailureReason } from '../apiError';
import { ApiError } from '../api';

// A lone surrogate — the thing that renders as `�`. Must never be MINTED by the truncation.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX = 160;

describe('writeFailureReason — boundary + lone-surrogate input', () => {
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
