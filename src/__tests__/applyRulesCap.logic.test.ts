// WHIT-508 — the client's APPLY_RULES_MAX_WRITES must equal the server's.
//
// The number is not decoration: the preview says "we file up to N at a time, so this will take a
// few rounds" BEFORE the user taps. If the client's copy says 300 while the server writes 100, the
// sheet promises three times what one tap delivers — exactly the dishonest-preview problem this
// feature exists to avoid. The repo's older CATEGORY_BATCH_LIMIT mirror is guarded by a comment
// alone, which is why this one is guarded by a test instead.
//
// Fail-on-revert: change either number and this reddens.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { APPLY_RULES_MAX_WRITES } from '../context';

describe('the apply-rules write cap mirrors the server', () => {
  it('matches APPLY_RULES_MAX_WRITES in lambda_api/constants.py', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../lambda_api/constants.py'), 'utf8');
    const match = source.match(/^APPLY_RULES_MAX_WRITES\s*=\s*(\d+)/m);

    // If this throws, the server constant was renamed or moved — fix the mirror, don't loosen
    // the regex, or the sheet quietly starts promising a number nothing enforces.
    expect(match).not.toBeNull();
    expect(APPLY_RULES_MAX_WRITES).toBe(Number(match![1]));
  });
});
