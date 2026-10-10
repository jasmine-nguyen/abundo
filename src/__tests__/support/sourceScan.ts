// Shared source-scanning helpers for the structural guards (WHIT-398 / WHIT-413).
//
// Three colour guards read the source tree rather than the runtime: accentAltSweep (no raw chip
// blue), themeLiterals (the raw-colour ratchet) and accentAltWashCards (the wash surfaces agree).
// They must agree on what "a shipped file" and "code, not a comment" mean — if one copy of the
// comment-stripper is sharpened and the others aren't, the guards start disagreeing about what
// they are even looking at.
//
// The shadowed-folder guard (themeLayout.logic.test.ts) is the fourth consumer: it drives walkSrc
// (below) to catch a file and a same-named folder sitting side by side.
//
// The router-mock scan (support/routerMockScan.ts) uses stripComments and matchingBrace to read
// each jest.mock(...) call whole.
//
// The shared-wait guard (sharedQueryWaits.screen) hands its line rule to findOffenders.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export const ROOT = join(__dirname, '..', '..', '..');

const SCAN_DIRS = ['app', 'src'];
const EXCLUDE = /(^|[\\/])(__tests__|node_modules)([\\/]|$)/;

// Repo-relative, forward-slashed, so keys read the same on any platform.
const repoPath =(abs: string): string => relative(ROOT, abs).split(sep).join('/');

// Every .ts/.tsx file that actually ships — tests excluded, since they legitimately contain the
// literals the guards are hunting for.
function shippedSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (EXCLUDE.test(relative(ROOT, abs))) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry)) out.push(abs);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  return out.sort();
}

// Every .ts/.tsx file under `dir`, relative to `root` and forward-slashed — the test-tree guards
// scan this.
export function testFiles(root: string, dir: string = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(root, path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [relative(root, path).split(sep).join('/')];
  });
}

export const TESTS_DIR = join(__dirname, '..');

// Every `file:line` under the test tree whose line matches, skipping allow-listed files
// (keys are testFiles keys: root-relative, forward-slashed).
export function findOffenders(
  match: (line: string) => boolean,
  allowed: Set<string>,
  root: string = TESTS_DIR,
): string[] {
  return testFiles(root)
    .filter((file) => !allowed.has(file))
    .flatMap((file) =>
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (match(line) ? [`${file}:${index + 1}`] : [])),
    );
}

// A comment describing a colour is documentation, not shipped colour — src/theme.ts spells several
// out in the token comments on purpose. The `[^:]` guard keeps `https://` inside a string from
// reading as the start of a line comment.
// Known rough edge: a `//` inside a non-URL string literal is treated as a comment. Contrived
// enough to accept; if that ever bites, fix it HERE and every guard picks it up.
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// repo-relative path -> its code with comments stripped.
export function shippedCode(): Map<string, string> {
  return new Map(shippedSourceFiles().map((abs) => [repoPath(abs), stripComments(readFileSync(abs, 'utf8'))]));
}

// Index of the closing character that matches the opening one at `open`, or -1. Works for any
// open/close pair ('{' '}' by default, '(' ')' for a call). Skips string literals whole.
export function matchingBrace(src: string, open: number, openChar = '{', closeChar = '}'): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const char = src[i];
    if (char === "'" || char === '"' || char === '`') {
      i = skipString(src, i);
      continue;
    }
    if (char === openChar) depth++;
    else if (char === closeChar && --depth === 0) return i;
  }
  return -1;
}

// Index of the closing quote of the string opened at `start`, honouring backslash escapes.
function skipString(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === quote) return i;
  }
  return src.length - 1;
}

// WHIT-413 — the shadowed-folder walk, kept here (a root param, not a hard-coded SRC_DIR) so it
// can be driven over a synthetic fixture tree as well as the real src/. In each directory a
// subfolder shadows a module when a same-named code file (.ts/.tsx/.js/.jsx) sits beside it and the
// folder holds a visible (non-dotfile) entry — a nested subfolder counts. Returns the offending
// src-relative pairs ("motion/foo") and every directory visited (proof the walk actually descended).
// __tests__ is skipped at every level. Why this matters is documented on the guard itself,
// themeLayout.logic.test.ts.
const CODE_FILE = /\.(t|j)sx?$/;

export function walkSrc(root: string): { shadowPairs: string[]; visited: string[] } {
  const shadowPairs: string[] = [];
  const visited: string[] = [];
  const hasVisibleEntry = (directory: string): boolean =>
    readdirSync(directory).some((entry) => !entry.startsWith('.'));

  const walk = (directory: string, relativePath: string) => {
    visited.push(relativePath);
    const entries = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith('.'),
    );

    const codeFileNames = new Set(
      entries
        .filter((entry) => entry.isFile() && CODE_FILE.test(entry.name))
        .map((entry) => entry.name.replace(CODE_FILE, '')),
    );

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '__tests__') continue;
      const childPath = join(directory, entry.name);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (codeFileNames.has(entry.name) && hasVisibleEntry(childPath)) {
        shadowPairs.push(childRelative);
      }
      walk(childPath, childRelative);
    }
  };

  walk(root, '');
  return { shadowPairs, visited };
}
