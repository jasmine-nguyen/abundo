// WHIT-828 — the fake "apply rules" report the server returns, shared by the filing tests.
// The base is an empty dry run; `alreadyFiled` and `createdRule` are optional on the wire, so
// they stay out unless a preset or the caller sets them.
import type { ApplyRulesResult, CreatedRule } from '../../api';

export function applyRulesReport(over: Partial<ApplyRulesResult> = {}): ApplyRulesResult {
  return {
    dryRun: true, rulesConsidered: 0, unfiled: 0, matched: 0, conflicted: 0, conflictedSamples: [],
    byCategory: {}, byRule: [], skippedRules: [], filed: [], vanished: [], failed: [], remaining: 0,
    ...over,
  };
}

/** The rule an inline "file by shop" run mints for Coles. */
export const COLES_CREATED_RULE: CreatedRule = { id: 'r1', field: 'description', operator: 'contains', value: 'coles', categoryId: 'groceries' };

/** The add-rule preview: a new Coles rule would file 12 of 20 unfiled charges. */
export const previewReport = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  rulesConsidered: 1, unfiled: 20, matched: 12, byCategory: { groceries: 12 },
  byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 12, samples: ['COLES 1234 RICHMOND', 'COLES 5678 CBD'] }],
  alreadyFiled: [], remaining: 12, createdRule: null, ...over,
});

/** The file-by-shop preview: all 20 unfiled charges match the shop. */
export const shopPreviewReport = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  rulesConsidered: 1, unfiled: 20, matched: 20, byCategory: { groceries: 20 },
  alreadyFiled: [], remaining: 20, createdRule: null, ...over,
});

/** A write run that filed t1 into groceries. */
export const filedReport = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  dryRun: false, rulesConsidered: 2, unfiled: 3, matched: 1, byCategory: { groceries: 1 },
  filed: [{ id: 't1', category: 'groceries' }], ...over,
});
