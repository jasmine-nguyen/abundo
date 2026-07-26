// WHIT — Rules grouping/search: adversarial gaps NOT covered by
// groupRulesByCategory.logic.test.ts. Locks literal (non-regex) matching, unicode
// case-folding, the "Uncategorized" name collision, and case-insensitive A–Z order.
// [A20]-[A23]
import { describe, it, expect } from '@jest/globals';
import { groupRulesByCategory, UNCATEGORIZED_RULE_GROUP, type Category, type Rule } from '../context';

const cat = (id: string, name: string): Category =>
  ({ id, name, icon: 'tag', color: '#fff', bucket: 'Lifestyle', recent: 0 });

const rule = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });

const shape = (groups: ReturnType<typeof groupRulesByCategory>) =>
  groups.map((g) => [g.category?.name ?? UNCATEGORIZED_RULE_GROUP, g.rules.map((r) => r.pattern)]);

describe('groupRulesByCategory — adversarial gaps', () => {
  // [A20] Regex-special query chars are matched LITERALLY (substring), never compiled as a
  // regex. If someone swaps `.includes(q)` for `new RegExp(q).test(...)`, ".*" would match
  // everything (incl. NETFLIX). This proves it does not.
  it('[A20] treats regex-special query chars as literal text, not a pattern', () => {
    const BILLS = cat('bills', 'Bills');
    const rules = [rule('1', 'PAY.*DAY', 'bills'), rule('2', 'NETFLIX', 'bills')];
    // ".*" is a literal substring of PAY.*DAY only.
    expect(shape(groupRulesByCategory(rules, [BILLS], '.*'))).toEqual([['Bills', ['PAY.*DAY']]]);
    // A lone "." must not match NETFLIX (which has no literal dot) — a regex "." would.
    expect(groupRulesByCategory([rule('2', 'NETFLIX', 'bills')], [BILLS], '.')).toEqual([]);
  });

  // [A21] Unicode/emoji patterns fold case correctly and match on substrings incl. accents.
  it('[A21] matches unicode/accented/emoji patterns case-insensitively', () => {
    const COFFEE = cat('coffee', 'Café ☕');
    const rules = [rule('1', 'CAFÉ ☕ NORD', 'coffee')];
    // Accented upper→lower fold ("É" -> "é") on both pattern and query.
    expect(groupRulesByCategory(rules, [COFFEE], 'café')).toHaveLength(1);
    // Emoji has no case; it still matches as a literal substring.
    expect(groupRulesByCategory(rules, [COFFEE], '☕')).toHaveLength(1);
    // Category-name accent match with the pattern not containing the query.
    expect(groupRulesByCategory([rule('9', 'PLAINASCII', 'coffee')], [COFFEE], 'café')).toHaveLength(1);
  });

  // [A22] A real category literally named "Uncategorized" must NOT be merged into the orphan
  // bucket — they are keyed differently (id vs the null sentinel). Two groups survive, and
  // the true orphan group is still pinned last.
  it('[A22] keeps a real "Uncategorized" category separate from the orphan group, orphan last', () => {
    const REAL = cat('real-uncat', UNCATEGORIZED_RULE_GROUP); // a category the user named this
    const rules = [rule('1', 'REALONE', 'real-uncat'), rule('2', 'GHOST', 'deleted-cat')];
    const groups = groupRulesByCategory(rules, [REAL]);
    expect(groups).toHaveLength(2);
    // First: the real category (has a non-null category object).
    expect(groups[0].category?.id).toBe('real-uncat');
    expect(groups[0].rules.map((r) => r.pattern)).toEqual(['REALONE']);
    // Last: the true orphan bucket (null category), never merged into the real one.
    expect(groups[1].category).toBeNull();
    expect(groups[1].rules.map((r) => r.pattern)).toEqual(['GHOST']);
  });

  // [A23] A–Z ordering is case-insensitive (localeCompare), not raw ASCII (`a < b`), where
  // uppercase 'Z' (90) would wrongly sort before lowercase 'a' (97).
  it('[A23] sorts group names case-insensitively (apple before Zebra)', () => {
    const APPLE = cat('a', 'apple');
    const ZEBRA = cat('z', 'Zebra');
    const rules = [rule('1', 'X', 'z'), rule('2', 'Y', 'a')];
    expect(groupRulesByCategory(rules, [APPLE, ZEBRA]).map((g) => g.category?.name)).toEqual(['apple', 'Zebra']);
  });
});
