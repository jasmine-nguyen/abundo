// WHIT-563 — the client's rule-condition vocabulary. MIRRORS the server's RULE_FIELD_OPERATORS /
// RULE_LOGIC / RULE_DIRECTIONS (lambda_api/constants.py, itself a mirror of shared/rule_engine).
// The engine evaluates only these (field, operator) pairs, so the builder's pickers must offer
// exactly this set — a pair the UI offers but the engine can't evaluate silently matches nothing.
// Guarded by ruleVocabulary.logic.test.ts (parity with constants.py + merchant_groups.py).
import type { RuleLogic } from './api';

export const RULE_FIELD_OPERATORS: Record<string, string[]> = {
  description: ['contains', 'equals'],
  merchant: ['contains', 'equals'],
  category: ['equals'],
  account: ['equals'],
  amount: ['less_than', 'less_than_or_equal', 'greater_than', 'greater_than_or_equal'],
  direction: ['is'],
};

export const RULE_LOGIC: RuleLogic[] = ['all', 'any'];
export const RULE_DIRECTIONS = ['debit', 'credit'] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

// The substring ("contains") value floor — mirrors merchant_groups.MIN_RULE_VALUE_ALPHANUMERICS. A
// near-empty contains value over-matches nearly everything, so the server (and this form) reject it.
export const MIN_RULE_VALUE_ALPHANUMERICS = 4;
export function ruleValueIsSafe(value: string): boolean {
  return (value.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_RULE_VALUE_ALPHANUMERICS;
}
