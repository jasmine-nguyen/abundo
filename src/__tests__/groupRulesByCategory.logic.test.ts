// Pure selector behind the Rules screen's grouped + searchable list. Locks the grouping,
// A–Z ordering, orphan handling, and search filter — a revert of any of these fails here.
import { describe, it, expect } from '@jest/globals';
import { groupRulesByCategory, UNCATEGORIZED_RULE_GROUP } from '../context';
import type { Category } from '../types';
import type { Rule } from '../model';

const cat = (id: string, name: string): Category =>
  ({ id, name, icon: 'tag', color: '#fff', bucket: 'Lifestyle' });

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

  // Case-insensitive (localeCompare), not raw ASCII, where 'Zebra' would sort before 'apple'.
  it('orders groups A–Z by category name', () => {
    const rules = [rule('1', 'NETFLIX', 'subs'), rule('2', 'STARBUCKS', 'coffee'), rule('3', 'COLES', 'groceries'), rule('4', 'X', 'z'), rule('5', 'Y', 'a')];
    const groups = groupRulesByCategory(rules, [SUBS, COFFEE, GROCERIES, cat('a', 'apple'), cat('z', 'Zebra')]);
    expect(groups.map((g) => g.category?.name)).toEqual(['apple', 'Cafes & Coffee', 'Groceries', 'Subscriptions', 'Zebra']);
  });

  it('groups an orphan rule (deleted category) under Uncategorized, pinned last', () => {
    const rules = [rule('1', 'MYSTERY', 'ghostcat'), rule('2', 'STARBUCKS', 'coffee')];
    const groups = groupRulesByCategory(rules, [COFFEE]);
    expect(groups.map((g) => g.category?.name ?? UNCATEGORIZED_RULE_GROUP)).toEqual(['Cafes & Coffee', 'Uncategorized']);
    expect(groups[1].category).toBeNull();
    expect(groups[1].rules.map((r) => r.pattern)).toEqual(['MYSTERY']);
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

  it('finds orphan rules by the literal word Uncategorized', () => {
    const rules = [rule('1', 'MYSTERY', 'ghostcat')];
    const groups = groupRulesByCategory(rules, [COFFEE], 'uncat');
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
  });
});

