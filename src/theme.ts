// Design tokens ported from Whittle.dc.html (Whittle).
export const C = {
  bg: '#0c0c10',
  bgDeep: '#0a0a0d',
  card: '#16161c',
  cardAlt: '#1c1c23',
  hairline: 'rgba(255,255,255,.05)',
  hairlineStrong: 'rgba(255,255,255,.08)',

  text: '#f4f4f6',
  textBright: '#f1f1f4',
  textMid: '#9a9aa4',
  textDim: '#83838d',
  textFaint: '#6a6a74',
  textFaintest: '#5a5a64',
  placeholder: '#6a6a74',

  accent: '#7c8cff',
  accentSoft: '#a8b2ff',
  accentSofter: '#c4caff',
  accentInk: '#13132e',

  good: '#35d9a0',
  goodBright: '#2fe3a6',
  warn: '#f4b740',
  warnAmber: '#f4b740',
  bad: '#ff6b6b',
  badBright: '#ff8e8e',

  purple: '#c9b3f5',

  heroInk: '#15123a',
  heroInk2: '#1c1846',
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
