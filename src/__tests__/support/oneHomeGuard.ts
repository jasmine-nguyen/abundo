// Shared setup for the "each category sample has one home" guards (WHIT-718, WHIT-719).
import { findOffenders } from './sourceScan';

export const CATEGORIES_HOME = 'support/categories.ts';

// Wraps text in quotes, so a guard can build its search text from pieces and never match itself.
export const quoted = (text: string) => `'${text}'`;

// Every `file:line` in the test tree that contains one of `copies`, skipping the samples' home and `allowed`.
export const findCopies = (copies: string[], allowed: string[]) =>
  findOffenders((line) => copies.some((copy) => line.includes(copy)), new Set([CATEGORIES_HOME, ...allowed]));
