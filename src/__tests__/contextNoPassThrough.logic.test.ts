// WHIT-630 slice 2: every screen, hook and test reads the data shapes, converters, pay clock
// and budget maths straight from their own files. context.tsx no longer passes them on, so the
// pass-through can't quietly come back.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SELF = path.resolve(__filename);

const MOVED_NAMES = [
  // ./types
  'Bucket', 'Category', 'Transaction',
  // ./model
  'Budget', 'Rule', 'RuleWrite', 'HomeLoanState', 'toCategory', 'toBudget', 'toRule',
  'EMPTY_LOAN_FACTS', 'loanFactsReady', 'UNCATEGORIZED_KEY', 'EARNED_KEY', 'INCOME_KEY',
  'ROLLUP_KEY', 'readRollup', 'readIncomeSources',
  // ./payCycle
  'cycleName', 'cycleClock', 'cycleStart', 'nextPayday', 'cycleClockView', 'elapsedFrac',
  // ./budgetMath
  'availableToSpend', 'paceTarget',
];

const LEAF_MODULES = ['./types', './model', './payCycle', './budgetMath', './queryKeys'];

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return sourceFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (path.resolve(full) === SELF) return [];
    return [full];
  });

// Every `import { … } from '<…>/context'` (relative path to the app's context module), with its names.
const contextImports = (source: string) => {
  const statements = source.match(/^\s*import\s+(?:type\s+)?\{[^}]*\}\s*from\s+['"](?:\.{1,2}\/)+(?:src\/)?context['"]/gm) ?? [];
  return statements.flatMap((statement) => {
    const braces = statement.slice(statement.indexOf('{') + 1, statement.indexOf('}'));
    return braces
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
  });
};

describe('context.tsx no longer passes on the moved pieces', () => {
  it.each(LEAF_MODULES)('context.tsx has no re-export from %s', (mod) => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'context.tsx'), 'utf8');
    const escaped = mod.replace(/[./]/g, '\\$&');
    const reExports = source.match(new RegExp(`^\\s*export[^;]*from\\s+['"]${escaped}['"]`, 'gm')) ?? [];
    expect(reExports).toEqual([]);
  });

  it('no screen, hook or test imports a moved name from context', () => {
    const offenders = [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'src'))]
      .flatMap((file) => {
        const moved = contextImports(fs.readFileSync(file, 'utf8')).filter((name) => MOVED_NAMES.includes(name));
        return moved.map((name) => `${path.relative(ROOT, file)}: ${name}`);
      });
    expect(offenders).toEqual([]);
  });
});
