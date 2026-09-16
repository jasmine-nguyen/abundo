// WHIT-563 — the client's rule vocabulary must equal the server's. The engine evaluates only the
// (field, operator) pairs in shared/rule_engine, mirrored by lambda_api/constants.py; the builder's
// pickers are a hand copy. If the two drift, the form offers a pair the engine can't evaluate (it
// silently matches nothing) or blocks one it can. This pins them together the way applyRulesCap
// pins the write cap. Fail-on-revert: change either side and this reddens.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { RULE_FIELD_OPERATORS, RULE_LOGIC, RULE_DIRECTIONS, MIN_RULE_VALUE_ALPHANUMERICS } from '../ruleVocabulary';

const readServer = (rel: string) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');
const quoted = (block: string) => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

describe('the client rule vocabulary mirrors the server', () => {
  const constants = readServer('lambda_api/constants.py');

  it('RULE_FIELD_OPERATORS matches lambda_api/constants.py', () => {
    const block = constants.match(/RULE_FIELD_OPERATORS\s*=\s*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    const server: Record<string, string[]> = {};
    for (const line of block![1].split('\n')) {
      const pair = line.match(/"([a-z_]+)":\s*frozenset\(\{([^}]*)\}\)/);
      if (pair) server[pair[1]] = quoted(pair[2]);
    }
    const client = Object.fromEntries(Object.entries(RULE_FIELD_OPERATORS).map(([k, v]) => [k, [...v].sort()]));
    expect(client).toEqual(server);
  });

  it('RULE_LOGIC matches', () => {
    const match = constants.match(/RULE_LOGIC\s*=\s*frozenset\(\{([^}]*)\}\)/);
    expect(match).not.toBeNull();
    expect([...RULE_LOGIC].sort()).toEqual(quoted(match![1]));
  });

  it('RULE_DIRECTIONS matches', () => {
    const match = constants.match(/RULE_DIRECTIONS\s*=\s*frozenset\(\{([^}]*)\}\)/);
    expect(match).not.toBeNull();
    expect([...RULE_DIRECTIONS].sort()).toEqual(quoted(match![1]));
  });

  it('MIN_RULE_VALUE_ALPHANUMERICS matches merchant_groups.py', () => {
    const source = readServer('lambda_api/merchant_groups.py');
    const match = source.match(/^MIN_RULE_VALUE_ALPHANUMERICS\s*=\s*(\d+)/m);
    expect(match).not.toBeNull();
    expect(MIN_RULE_VALUE_ALPHANUMERICS).toBe(Number(match![1]));
  });
});
