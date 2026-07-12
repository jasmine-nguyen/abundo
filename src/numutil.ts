// Shared money-input helpers (WHIT-256). The forms and sheets all read a plain-text
// amount off a decimal-pad keyboard and seed the input from a stored number, so the
// parse + seed rules live here once rather than drifting across app/loan.tsx,
// app/goal/edit.tsx, and the goal-balance sheet.

// Parse a clean decimal amount, else NaN. Rejects trailing garbage ("80abc"), exponents
// ("1e3"), signs, and blanks — any of which a paste can slip past the decimal-pad keyboard.
// The regex is unsigned, so every value it accepts is >= 0.
export function parseAmount(text: string): number {
  const trimmed = text.trim();
  if (!/^\d*\.?\d+$/.test(trimmed)) return NaN;
  return parseFloat(trimmed);
}

// A stored number -> the text an input starts with ('' when unset). 0 seeds as "0".
export function numText(n: number | null | undefined): string {
  return n == null ? '' : String(n);
}
