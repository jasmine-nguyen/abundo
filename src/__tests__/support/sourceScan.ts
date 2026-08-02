// Shared source-scanning helpers for the structural guards (WHIT-398).
//
// Three tests read the source tree rather than the runtime: accentAltSweep (no raw chip blue),
// themeLiterals (the raw-colour ratchet) and accentAltWashCards (the wash surfaces agree). They
// must agree on what "a shipped file" and "code, not a comment" mean — if one copy of the
// comment-stripper is sharpened and the others aren't, the guards start disagreeing about what
// they are even looking at.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export const ROOT = join(__dirname, '..', '..', '..');

const SCAN_DIRS = ['app', 'src'];
const EXCLUDE = /(^|[\\/])(__tests__|node_modules)([\\/]|$)/;

// Repo-relative, forward-slashed, so keys read the same on any platform.
export const repoPath = (abs: string): string => relative(ROOT, abs).split(sep).join('/');

// Every .ts/.tsx file that actually ships — tests excluded, since they legitimately contain the
// literals the guards are hunting for.
export function shippedSourceFiles(): string[] {
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

// Any quoted colour a human typed by hand: rgb()/rgba() with numeric channels, or a #hex in all
// four lengths React Native accepts. Longest hex first — #[0-9a-f]{6}\b can neither match nor
// backtrack out of an 8-digit hex, so without the {8} branch '#7c8cffcc' slips through entirely.
export const RAW_COLOR_SOURCE =
  String.raw`['"\`](?:rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+|#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b)`;
