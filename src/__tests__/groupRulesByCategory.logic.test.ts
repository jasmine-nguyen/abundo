// Pure selector behind the Rules screen's grouped + searchable list. Locks the grouping,
// A–Z ordering, orphan handling, and search filter — a revert of any of these fails here.
import { describe, it, expect } from '@jest/globals';
import { groupRulesByCategory, UNCATEGORIZED_RULE_GROUP, type Category, type Rule } from '../context';

const cat = (id: string, name: string): Category =>
  ({ id, name, icon: 'tag', color: '#fff', bucket: 'Lifestyle', recent: 0 });

const rule = (id: string, pattern: string, categoryId: string): Rule =>
  ({ id, pattern, categoryId, isNew: false });

// A stable, readable shape for assertions: [categoryName, [rulePattern, ...]].
const shape = (groups: ReturnType<typeof groupRulesByCategory>) =>
  groups.map((g) => [g.category?.name ?? UNCATEGORIZED_RULE_GROUP, g.rules.map((r) => r.pattern)]);

const COFFEE = cat('coffee', 'Cafes & Coffee');
const SUBS = cat('subs', 'Subscriptions');
const GROCERIES = cat('groceries', 'Groceries');

describe('groupRulesByCategory', () => {
  it('collapses multiple rules for one category into a single group', () => {
    const rules = [rule('1', 'STARBUCKS', 'coffee'), rule('2', 'KKV', 'coffee')];
    expect(shape(groupRulesByCategory(rules, [COFFEE]))).toEqual([['Cafes & Coffee', ['STARBUCKS', 'KKV']]]);
  });

  it('omits categories that have no rules', () => {
    const rules = [rule('1', 'STARBUCKS', 'coffee')];
    const groups = groupRulesByCategory(rules, [COFFEE, SUBS, GROCERIES]);
    expect(groups.map((g) => g.category?.name)).toEqual(['Cafes & Coffee']);
  });

  it('orders groups A–Z by category name', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee'), rule('3', 'COLES', 'groceries')];
    const groups = groupRulesByCategory(rules, [SUBS, COFFEE, GROCERIES]);
    expect(groups.map((g) => g.category?.name)).toEqual(['Cafes & Coffee', 'Groceries', 'Subscriptions']);
  });

  it('rules keep their incoming order within a group', () => {
    const rules = [rule('1', 'B', 'coffee'), rule('2', 'A', 'coffee'), rule('3', 'C', 'coffee')];
    expect(groupRulesByCategory(rules, [COFFEE])[0].rules.map((r) => r.pattern)).toEqual(['B', 'A', 'C']);
  });

  it('groups an orphan rule (deleted category) under Uncategorized, pinned last', () => {
    const rules = [rule('1', 'MYSTERY', 'ghostcat'), rule('2', 'STARBUCKS', 'coffee')];
    const groups = groupRulesByCategory(rules, [COFFEE]);
    expect(groups.map((g) => g.category?.name ?? UNCATEGORIZED_RULE_GROUP)).toEqual(['Cafes & Coffee', 'Uncategorized']);
    expect(groups[1].category).toBeNull();
    expect(groups[1].rules.map((r) => r.pattern)).toEqual(['MYSTERY']);
  });

  it('treats an empty-string categoryId as an orphan (Uncategorized)', () => {
    const groups = groupRulesByCategory([rule('1', 'ODD', '')], [COFFEE]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
  });

  it('an empty categories array collapses every rule under Uncategorized (cold-load)', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee')];
    const groups = groupRulesByCategory(rules, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
    expect(groups[0].rules.map((r) => r.pattern)).toEqual(['NETFLIX', 'STARBUCKS']);
  });

  it('an empty query returns every group', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee')];
    expect(groupRulesByCategory(rules, [SUBS, COFFEE], '')).toHaveLength(2);
  });

  it('a whitespace-only query is treated as empty', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee')];
    expect(groupRulesByCategory(rules, [SUBS, COFFEE], '   ')).toHaveLength(2);
  });

  it('filters by pattern substring, case-insensitively', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee')];
    expect(shape(groupRulesByCategory(rules, [SUBS, COFFEE], 'flix'))).toEqual([['Subscriptions', ['NETFLIX']]]);
  });

  it('filters by category name when the pattern does not match', () => {
    const rules = [rule('1', 'STARBUCKS', 'coffee')];
    // "coffee" is nowhere in "STARBUCKS", but it is in the category name "Cafes & Coffee".
    expect(shape(groupRulesByCategory(rules, [COFFEE], 'coffee'))).toEqual([['Cafes & Coffee', ['STARBUCKS']]]);
  });

  it('trims surrounding whitespace in the query before matching', () => {
    const rules = [rule('1', 'NETFLIX', 'subs')];
    expect(groupRulesByCategory(rules, [SUBS], '  netflix  ')).toHaveLength(1);
  });

  it('finds orphan rules by the literal word Uncategorized', () => {
    const rules = [rule('1', 'MYSTERY', 'ghostcat')];
    const groups = groupRulesByCategory(rules, [COFFEE], 'uncat');
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
  });

  it('returns [] when nothing matches the query', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee')];
    expect(groupRulesByCategory(rules, [SUBS, COFFEE], 'zzznope')).toEqual([]);
  });

  it('keeps two distinct categories that share a name as separate groups', () => {
    const dupeA = cat('a', 'Food');
    const dupeB = cat('b', 'Food');
    const rules = [rule('1', 'AAA', 'a'), rule('2', 'BBB', 'b')];
    const groups = groupRulesByCategory(rules, [dupeA, dupeB]);
    expect(groups).toHaveLength(2);
    expect(groups.flatMap((g) => g.rules.map((r) => r.pattern)).sort()).toEqual(['AAA', 'BBB']);
  });
});

// Adversarial gaps — literal (non-regex) matching, unicode case-folding, the "Uncategorized" name
// collision, and case-insensitive A–Z order. [A20]-[A23]
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
