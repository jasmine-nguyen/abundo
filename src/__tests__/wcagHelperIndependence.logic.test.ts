// WHIT-430 / WHIT-431 (QA gap) — [Q40], the ONE guarantee support/wcag.ts leans on that was, until
// now, only a comment: the shared hand-written WCAG maths must NEVER import from src/contrast.ts.
//
// Why a static/source test and not a runtime one: the whole value of support/wcag.ts is that it
// measures the shipped colours (and src/contrast.ts itself) INDEPENDENTLY. If it imported the code
// under test, every guard built on it — [Q27]/[Q28]/[Q29] in otherColorToken, [Q36]-[Q38] in
// contrastEdges — would quietly become "the code agrees with itself", i.e. a tautology that passes
// no matter how wrong contrast.ts is. Nothing at runtime can catch that (an import would still
// return plausible numbers). So we assert it structurally, against the file's own source text.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('support/wcag.ts stays independent of the code it measures', () => {
  it('[Q40] never imports (statically or dynamically) from src/contrast.ts', () => {
    const src = readFileSync(join(__dirname, 'support', 'wcag.ts'), 'utf8');

    // Match a real MODULE reference to contrast, in either import form, tolerant of any relative
    // depth (./contrast, ../contrast, ../../contrast) and of a trailing extension. The header's
    // prose mentions "src/contrast.ts" freely — that is not a `from '...'`/`require('...')` target,
    // so it is (correctly) not matched. The file's OWN identifiers (contrastRatio, contrastHex) are
    // likewise never at a module-specifier position.
    const staticImport = /from\s*['"][^'"]*\/contrast(\.ts)?['"]/;
    const dynamicImport = /(?:require|import)\s*\(\s*['"][^'"]*\/contrast(\.ts)?['"]\s*\)/;

    expect(src).not.toMatch(staticImport);
    expect(src).not.toMatch(dynamicImport);

    // Guard the guard: the same patterns MUST fire on the string they are meant to catch, so a typo
    // that neutered the regex could not let this test pass silently.
    expect(`import { contrastRatio } from '../contrast';`).toMatch(staticImport);
    expect(`const c = require('./contrast');`).toMatch(dynamicImport);
  });
});
