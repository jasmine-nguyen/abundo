// WHIT-799 — the add-rule, apply-rules, file-by-shop and filing-suggestion screen suites build
// their ../context stand-in with the shared realContextWith (support/contextMock), not a hand copy.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const RULES_AND_FILING_SUITES = [
  'addRuleConfirmBudgetExcluded',
  'addRulePreview',
  'addRulePreviewGaps',
  'AddRuleSheet',
  'AddRuleSheetBudgetExcludedEdit',
  'AddRuleSheetClassicPathUntouched',
  'AddRuleSheetMultiCondition',
  'AddRuleSheetMultiConditionGaps',
  'AddRuleSheetOverlapWarning',
  'AddRuleSheetSpread',
  'AddRuleSheetSpreadGaps',
  'confirmSheetMountStability',
  'whit670AddRuleRealDataQa',
  'applyRulesButton',
  'applyRulesJobSheet',
  'applyRulesJobStallSheet',
  'applyRulesJobVariantSheet',
  'applyRulesRounds',
  'applyRulesSheet',
  'whit670ApplyRulesPopupsServerEdges',
  'fileByShopButton',
  'fileByShopOffScreenClash',
  'fileByShopSheet',
  'fileByShopSheetGaps',
  'fileOneOffsIntent',
  'fileOneOffsIntentGaps',
  'filingSuggestions',
  'filingSuggestions.gaps',
].map((name) => `${name}.screen.test.tsx`);

const INLINE_CONTEXT_FACTORY = /requireActual\(\s*['"]\.\.\/context['"]\s*\)/;
const SHARED_BUILDER = /jest\.mock\(\s*'\.\.\/context',\s*\(\)\s*=>\s*require\('\.\/support\/contextMock'\)\.realContextWith\(/;

describe('rules and filing screen suites share one context stand-in builder', () => {
  it('each suite mocks ../context through realContextWith, with no hand-built factory', () => {
    const offenders = RULES_AND_FILING_SUITES.filter((file) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      return INLINE_CONTEXT_FACTORY.test(source) || !SHARED_BUILDER.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
