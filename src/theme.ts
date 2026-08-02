// Design tokens ported from Whittle.dc.html (Whittle).
export const C = {
  bg: '#16161e',
  bgDeep: '#13131a',
  card: '#1f2030',
  cardAlt: '#24263a',
  hairline: 'rgba(122,162,247,.1)',
  hairlineStrong: 'rgba(122,162,247,.16)',

  text: '#c0caf5',
  textBright: '#d5daf5',
  textMid: '#a9b1d6',
  textDim: '#8f97c0',
  textFaint: '#565f89',
  textFaintest: '#414868',
  placeholder: '#565f89',

  accent: '#7aa2f7',
  accentSoft: '#9db3f9',
  accentSofter: '#c0caf5',
  accentInk: '#16161e',

  good: '#2ac3de',
  goodBright: '#42d4ec',
  surplus: '#7ee0a0', // brighter green for the Earned-vs-Spent surplus headline (WHIT-324)
  warn: '#e0af68',
  warnAmber: '#e0af68',
  bad: '#f7768e',
  badBright: '#ff8fa3',

  purple: '#bb9af7',

  heroInk: '#16161e',
  heroInk2: '#1a1b26',

  // Hero card gradient (Tokyo Night): accent-blue → indigo → purple, 150°.
  heroGradFrom: '#7aa2f7',
  heroGradMid: '#8b8ff5',
  heroGradTo: '#bb9af7',
} as const;

export const FONT = {
  // 'Inter Tight' / 'Inter' in the mockup. On web these resolve via the Google Fonts
  // stylesheet (so fontWeight works); on native they are registered by expo-font in
  // app/_layout with a representative weight per family.
  display: 'Inter Tight',
  body: 'Inter',
} as const;

// Convert a #rrggbb hex + alpha into an rgba() string (port of prototype `tint`).
export function tint(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function fmt(n: number): string {
  return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}

// The refund / remainder-"Other" / reversed-source / normal row convention shared by the Insights
// category list and the Earned/Spent breakdown screen (WHIT-375/376). A refund reads as an UNSIGNED
// green credit (fmt drops the sign; the green carries "credit"); a remainder "Other" plug is dimmed
// and KEEPS its sign when negative (it can be, and the rows must still add up — WHIT-357); a REVERSED
// income source (WHIT-376) is a real, tappable category clawed back this cycle — it shows a signed
// "−$X" in a neutral mid tone (a reduction, not a green gain) with a BRIGHT name (it's a real row);
// a normal row is a positive amount in the bright ink. `spent` is the row's signed amount
// (CategoryBreakdownRow.spent / the breakdown screen's item amount). One source of truth so the
// screens can't drift (the refund line already regressed to a signed "-$30" once).
export function breakdownLineStyle(
  row: { isRefund?: boolean; isRemainder?: boolean; isReversed?: boolean; spent: number },
): { amountText: string; amountColor: string; nameColor: string } {
  const { isRefund, isRemainder, isReversed, spent } = row;
  return {
    amountText: (isRemainder || isReversed) && spent < 0 ? `-${fmt(spent)}` : fmt(spent),
    amountColor: isRefund ? C.good : isRemainder ? C.textDim : isReversed ? C.textMid : C.textBright,
    nameColor: isRefund || isRemainder ? C.textDim : C.textBright,
  };
}

// Half-a-cent float-dust tolerance (WHIT-380). A signed money amount whose |value| is below this
// reconciles to zero: drop it (a ~$0-net income source) or suppress the "adjustment" plug (its
// residual is dust). Real money only goes to the cent, so anything under half a cent is rounding
// noise, never a real amount. The single source of truth for the three reconcile guards that
// previously each hard-coded 0.005 (src/context.tsx, src/queries.ts).
export const RECONCILE_EPSILON = 0.005;

// The muted "Pending/refund adjustment" reconciliation row's shared visual fields (WHIT-380). Both
// the Spend remainder line and the Earned adjustment plug (src/context.tsx — categoryBreakdown and
// incomeBreakdown) build a row from these — spread this in and add each screen's own shape
// fields. One source of truth so the label/icon/tone can't drift between the two (they duplicated
// these literals by hand before, and the sibling refund line had already regressed once).
export const ADJUSTMENT_ROW = {
  name: 'Pending/refund adjustment',
  icon: 'sliders',
  color: C.textDim,
  chipBg: tint(C.textDim, 0.15),
} as const;

export function fmt2(n: number): string {
  return (n < 0 ? '-' : '+') + '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// An account balance label (WHIT-212): "-$596,642.43" / "$96,270.59". The sign shows only
// for a negative balance (money owed) — a positive balance is bare, with colour (green vs
// red) carrying "in credit vs owing". Distinct from fmt2, which always prefixes +/−.
export function fmtBalance(n: number): string {
  return (n < 0 ? '-' : '') + '$' +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A money label that stays whole-dollar unless the amount has real cents, so a "spent"/"left"
// figure matches the transaction rows it's summed from: $80 reads "$80", but $73.50 reads
// "$73.50" instead of rounding up to "$74". Unsigned (abs) like fmt — the budget hero shows no
// sign. Distinct from fmt (always whole) and fmt2 (always 2dp, always signed).
export function fmtExact(n: number): string {
  const abs = Math.abs(n);
  const hasCents = Math.round(abs * 100) % 100 !== 0;
  return '$' + abs.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

// One decimal place of `unit`, but ONLY when that says the figure exactly; otherwise the full
// amount. Rounding is deliberately not allowed: this labels a LIMIT, and rounding up would name
// an amount the limit itself rejects — "$1.3B or less" when the real cap is $1.25B sends the user
// round a loop, retyping the figure the message gave them. Naming it in full is never wrong.
function scaledOrFull(abs: number, unit: number, suffix: string): string {
  if ((abs * 10) % unit !== 0) return fmt(abs);
  return `$${abs / unit}${suffix}`;
}

// A short money label for warning copy — "$1B", "$1.5B", "$500M". Drops a trailing ".0", so a
// round billion reads "$1B" rather than "$1.0B", and spells out anything one decimal can't say
// exactly ($1,250,000,000). Below a million it defers to fmt — abbreviating small amounts reads
// worse than spelling them out. Unsigned (abs) like fmt. Used for the loan form's ceiling toasts
// (WHIT-393) so the message follows LOANFACTS_FIELD_MAX instead of hard-coding the figure.
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return scaledOrFull(abs, 1_000_000_000, 'B');
  if (abs >= 1_000_000) return scaledOrFull(abs, 1_000_000, 'M');
  return fmt(abs);
}

// A short "when did this happen" label from an ISO timestamp (e.g. "just now",
// "5m ago", "3h ago", "2d ago"). `now` is injectable so it can be unit-tested
// deterministically. Returns '' for a null/blank/unparseable input so callers can
// simply hide the stamp. Future timestamps (clock skew) clamp to "just now".
export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
