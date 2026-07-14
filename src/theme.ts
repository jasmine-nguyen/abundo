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
