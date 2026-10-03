---
name: Abundo
description: A calm Tokyo Night budget and mortgage tracker where the few bright moments are the rewards.
colors:
  tokyo-blue: "#7aa2f7"
  tokyo-blue-soft: "#9db3f9"
  periwinkle-wash: "#7c8cff"
  dusk-indigo: "#8b8ff5"
  dusk-lilac: "#bb9af7"
  night-bg: "#16161e"
  night-bg-deep: "#13131a"
  night-card: "#1f2030"
  night-card-raised: "#24263a"
  ink-bright: "#d5daf5"
  ink: "#c0caf5"
  ink-info: "#cfd2ff"
  ink-mid: "#a9b1d6"
  ink-dim: "#8f97c0"
  ink-faint: "#565f89"
  ink-faintest: "#414868"
  hero-ink: "#16161e"
  good-cyan: "#2ac3de"
  surplus-green: "#7ee0a0"
  under-green: "#9ece6a"
  warn-amber: "#e0af68"
  bad-rose: "#f7768e"
typography:
  hero-number:
    fontFamily: "Inter Tight"
    fontSize: "54px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-2px"
  headline:
    fontFamily: "Inter Tight"
    fontSize: "30px"
    fontWeight: 800
    letterSpacing: "-1px"
  title:
    fontFamily: "Inter Tight"
    fontSize: "19px"
    fontWeight: 700
    letterSpacing: "-0.2px"
  amount:
    fontFamily: "Inter Tight"
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "-0.3px"
  body:
    fontFamily: "Inter"
    fontSize: "15px"
    fontWeight: 600
  body-small:
    fontFamily: "Inter"
    fontSize: "13px"
    fontWeight: 600
  label:
    fontFamily: "Inter"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.3px"
  tab-label:
    fontFamily: "Inter"
    fontSize: "10.5px"
    fontWeight: 600
rounded:
  check: "7px"
  pill: "12px"
  chip: "13px"
  field: "14px"
  button: "15px"
  card: "18px"
  card-feature: "20px"
  hero: "26px"
  round: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "14px"
  lg: "16px"
  xl: "18px"
  hero: "24px"
components:
  button-primary:
    backgroundColor: "{colors.tokyo-blue}"
    textColor: "{colors.hero-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    padding: "16px"
    height: "53px"
  card:
    backgroundColor: "{colors.night-card}"
    rounded: "{rounded.card}"
    padding: "16px"
  card-budget-row:
    backgroundColor: "{colors.night-card}"
    rounded: "{rounded.card-feature}"
    padding: "16px"
  list-row:
    backgroundColor: "{colors.night-card}"
    rounded: "{rounded.field}"
    padding: "13px 14px"
  input:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "0 14px"
    height: "50px"
  hero-card:
    backgroundColor: "{colors.tokyo-blue}"
    textColor: "{colors.hero-ink}"
    rounded: "{rounded.hero}"
    padding: "24px"
  segmented-control:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.field}"
    padding: "3px"
  category-chip:
    rounded: "{rounded.chip}"
    size: "42px"
  tab-bar:
    backgroundColor: "{colors.night-bg}"
    textColor: "{colors.ink-faint}"
    typography: "{typography.tab-label}"
  tab-bar-active:
    textColor: "{colors.tokyo-blue}"
---

# Design System: Abundo

## Overview

**Creative North Star: "The Quiet Glow"**

Abundo is a dim, restful room with a few lights on. Almost everything sits in deep Tokyo Night navy, in soft lavender-grey ink, at low contrast to its neighbours, so a glance at night never glares. Against that quiet, a handful of moments are allowed to shine: the blue-to-lilac hero card at the top of a screen, the cyan "under budget" number, the confetti when a milestone lands. Their brightness is the reward, and it only works because everything else stays dim.

The feel is calm first, rewarding second. Density is moderate: generous card padding (16–24pt), rows that breathe, one big number per screen. Shapes are soft and friendly — every surface is rounded (14–26pt), outlined with a faint blue hairline rather than lifted by a shadow. Motion is short and springy and always gives way to "reduce motion".

**Key Characteristics:**
- Dark-only Tokyo Night palette; layering by slightly lighter navy, never by shadow.
- One saturated gradient surface per screen (the hero card), carrying the screen's one big number.
- Soft rounded geometry throughout, from 7pt checkboxes to 26pt hero cards.
- Inter Tight for numbers and titles, Inter for everything else.
- Colour carries meaning: cyan = on track, rose = over, amber = warning, green = surplus.

## Colors

A cool, low-glare night palette of navy surfaces and lavender ink, lit by one blue and a dusk gradient.

### Primary
- **Tokyo Blue**: the one interactive tint. Primary buttons, the selected tab, checked boxes, links, and the first stop of the hero gradient. The theme writes this hex once (`ACCENT` in `src/theme.ts`); hairlines and the gradient derive from it.
- **Tokyo Blue Soft**: a lighter step of the same blue for secondary emphasis on dark surfaces.

### Secondary
- **Periwinkle Wash**: the app's second blue, deliberately *not* a shade of Tokyo Blue. Used only as a translucent wash (≈0.1 fill / 0.22 border) for add buttons, dashed "new X" rows, retry pills, selected rows, the AI coach card and other "soft call-to-action" surfaces.

### Tertiary
- **Dusk Indigo** and **Dusk Lilac**: the middle and end stops of the hero gradient (Tokyo Blue → Dusk Indigo → Dusk Lilac at 150°). Dusk Lilac also appears as the Lifestyle bucket colour.

### Neutral
- **Night** (`night-bg`): the screen background, the tab bar, and the ink on bright surfaces.
- **Night Deep**: the deepest well, behind the app's lowest layers.
- **Night Card**: the default card, row, field and segmented-control surface.
- **Night Card Raised**: one step brighter, for a surface inside a card.
- **Ink Bright → Ink → Ink Mid → Ink Dim → Ink Faint → Ink Faintest**: a six-step lavender-grey text ramp. Bright for amounts and merchant names, Ink for body copy, Mid for section labels, Dim for secondary meta, Faint for placeholders and inactive tabs, Faintest for disabled.
- **Ink Info**: a muted lavender for "pace" sub-lines and income status.
- **Hairline**: Tokyo Blue at 10% (16% for the strong variant). Every card border and row divider.

### Status
- **Good Cyan**: on track, under budget, a refund credit, the Income bucket.
- **Surplus Green**: the Earned-vs-Spent surplus headline only.
- **Under Green**: under-budget deltas in the Ask Abundo chat.
- **Warn Amber**: the 80% budget heads-up.
- **Bad Rose**: over budget, the uncategorised dot, destructive actions.

### Category palettes
Categories have their own fixed hues and are not part of the UI palette above. `src/categoryColors.ts` (13 built-in Tokyo Night hues plus darker siblings) colours budgets and transactions. `src/chartColors.ts` (a 20-step even-lightness ramp, plus a neutral grey for "Other") colours the Insights donut. Both are computed sets: never hand-tune one hex.

### Named Rules
**The One Tint Rule.** Tokyo Blue means "you can tap this" or "this is selected". It never decorates. Soft calls-to-action use the Periwinkle Wash instead.

**The One Glow Rule.** Only one gradient hero card per screen. If two surfaces are both shouting, the screen is no longer quiet.

**The Derive-Don't-Copy Rule.** Hairlines and the gradient's first stop are built from the accent with `tint()`. A new accent-derived shade derives too; it never hard-codes a second copy of the hex.

## Typography

**Display Font:** Inter Tight (registered with expo-font)
**Body Font:** Inter

**Character:** Inter Tight's compressed, heavy numerals make a dollar figure feel solid and celebratory. Inter keeps everything around it quiet and legible.

### Hierarchy
- **Hero number** (800, 54pt, line-height 1, −2 tracking): the one big number on a hero card, such as days left in the cycle.
- **Headline** (800, 30pt, −1 tracking): the secondary figure on a hero card, such as the amount remaining.
- **Title** (700, 19pt, −0.2 tracking): screen headers, centred between two 40pt slots.
- **Amount** (700, 16pt, −0.3 tracking): transaction and row amounts, in Inter Tight.
- **Body** (600, 15pt): merchant names, row titles, button labels (700 on buttons).
- **Body small** (600, 13pt): meta lines, hero eyebrows, pill text.
- **Label** (700, 12pt, +0.3 tracking): section labels above groups of cards, in Ink Mid.
- **Tab label** (600, 10.5pt): tab bar labels.

Sizes are fixed point values today; the app does not follow the iPhone's text-size setting (Dynamic Type).

### Named Rules
**The Numbers-Wear-Tight Rule.** Money and counts are set in Inter Tight with negative tracking; words are set in Inter. A dollar figure in Inter, or a sentence in Inter Tight, reads off-brand.

**The Heavy-Is-Rare Rule.** Weight 800 is reserved for hero figures. Everything else lives at 600–700.

## Layout

Single-column phone layout. Screens use 18–20pt side gutters. Cards stack with 12pt gaps; hero cards take 14–22pt below them. Inside cards the rhythm is 16pt padding, 13pt between an icon chip and its text, and 8–10pt between stacked rows.

The tab bar and header float. As you scroll, the tab bar slides away (`useScrollNavBars`) and content runs underneath, so every scroll view pads its bottom to clear it. The floating "Ask" button sits 16pt above the tab bar and stays put when the bar hides.

## Elevation & Depth

Flat by default. Depth comes from tonal layering (Night → Night Card → Night Card Raised), each step a slightly lighter navy, with a 1pt Tokyo Blue hairline at 10% marking every edge. Hero cards stand out by colour, not by lift: two large translucent white circles in the top-right corner give them a soft, playful depth.

### Shadow Vocabulary
- **Floating action** (`shadowColor #000, opacity 0.6, radius 12, offset 0/10`): the Ask button only, because it floats over scrolling content.

### Named Rules
**The Flat-By-Default Rule.** Cards, rows, sheets and fields never cast shadows. A shadow is reserved for something that floats above scrolling content.

## Shapes

Everything is rounded, and the radius grows with the surface: checkboxes 7pt, pills 12pt, icon chips 13pt, fields and list rows 14pt, buttons 15pt, cards 18pt, budget and insight rows 20pt, hero cards 26pt. Progress bars round their ends at 60% of their height. Circles appear as hero blobs, checkpoint dots on progress bars, and the Ask button.

Borders are always 1pt hairlines in a Tokyo Blue tint (or `rgba(255,255,255,.08)` on some text fields). Dashed borders mark "add a new thing" rows.

## Components

### Buttons
Soft, wide and confident.
- **Shape:** gently rounded (15pt), full width, 16pt vertical padding, at least 53pt tall.
- **Primary:** a Tokyo Blue fill with Night ink, 16pt Inter 700.
- **Soft / secondary:** a Periwinkle Wash (0.1 fill, 0.22 border) with Periwinkle or Ink text.
- **Pressed:** dims to ~0.6–0.85 opacity and shrinks slightly (0.92–0.96 scale). There is no separate hover state on iOS.
- **Icon button:** a 40×40pt square, 12pt radius, `rgba(255,255,255,.06)` fill (header actions such as the settings gear).

### Segmented control
Pill-shaped switch for "This cycle / Last cycle" and "Spending / Earning". A Night Card container (14pt radius, 3pt inset, hairline border) holds segments with an 11pt radius. Inactive text is Ink Dim 600; the active segment takes a tint fill passed by the caller and bolds to 700.

### Cards / Containers
- **Corner style:** 18pt (detail cards), 20pt (budget and insight rows), 14pt (list rows).
- **Background:** Night Card.
- **Shadow strategy:** none (see Elevation & Depth).
- **Border:** 1pt Hairline.
- **Internal padding:** 16pt (18pt on budget detail).

### Hero card (signature)
The one bright surface per screen. A 150° gradient (Tokyo Blue → Dusk Indigo → Dusk Lilac) clipped to a 26pt radius, with two translucent white circles overflowing the top-right corner. Content is Night ink: a muted eyebrow (13pt, ~62% ink), the hero number (54pt Inter Tight 800), and a bottom row pairing a headline figure with a small translucent ink pill (12pt radius). Used on Budgets, Insights, Mortgage and Milestones.

### Progress bars
- **BudgetBar:** a 10pt track (`rgba(255,255,255,.07)`) with a solid posted fill, a translucent pending fill after it, and a white "where you should be by now" tick below. This is how pending spend shows up honestly.
- **Bar:** a single-fill variant with optional checkpoint dots (filled = reached, hollow = not yet).

### Category chip
A 42×42pt rounded square (13pt radius) holding a category glyph in the category colour on a faint tint of that colour. Leads every transaction and category row.

### Inputs / Fields
- **Style:** a Night Card (or Night) fill, 1pt hairline, 14pt radius, 50pt tall, 16pt Inter in Ink.
- **Placeholder:** Ink Faint.
- **Focus:** no custom ring; the system caret carries focus.

### Navigation
- **Tab bar:** a custom floating bar on Night with a hairline top border and five tabs (Budgets, Transactions, Accounts, Insights, Goals). 24pt custom glyphs over 10.5pt labels; active is Tokyo Blue, inactive Ink Faint. A Bad Rose dot with a Night ring flags uncategorised transactions. Tabs cross-fade on switch, and the fade is off under "reduce motion".
- **Header:** a custom centred 19pt title between two 40pt slots; either slot can hold an icon button.
- **Sheets:** bottom sheets rise 64pt on a spring (friction 12, tension 90) with a fade. They dismiss on a 56pt pull or a quick flick of the grabber, and appear instantly under "reduce motion".

### Icons
A custom line-icon set (`src/icons.tsx`), ported from the original prototype: 24pt grid, 1.8–1.9pt rounded strokes, drawn in `currentColor`.

### Celebration
A confetti burst over the screen when a goal checkpoint is crossed. It never blocks taps, and under "reduce motion" it becomes a brief plain banner.

## Do's and Don'ts

### Do:
- **Do** read every colour from `C`, `BUCKET_COLOR`, `colorForCategory` or the chart palette. Raw hex in a screen is a ratchet-guarded regression.
- **Do** keep one gradient hero card per screen, carrying that screen's single most important number.
- **Do** separate surfaces with a lighter navy step plus a 1pt Tokyo Blue hairline.
- **Do** set money in Inter Tight with negative tracking.
- **Do** show pending spend as a translucent extension of the posted fill, never hidden and never merged.
- **Do** give every motion a "reduce motion" fallback (instant or crossfade).
- **Do** use Periwinkle Wash, not Tokyo Blue, for soft "add / retry / suggest" surfaces.

### Don't:
- **Don't** add shadows to cards, rows or sheets. The Ask button is the only shadowed element.
- **Don't** introduce a light theme or swap away from Tokyo Night. It's a brand commitment.
- **Don't** use Tokyo Blue as decoration; it means "tappable" or "selected".
- **Don't** write `tint(C.accent, a)` where `tint(C.accentAlt, a)` is meant. They are different blues, and a test guards it.
- **Don't** hand-tune individual hexes in the category or chart palettes; they're computed sets.
- **Don't** use alarm-red styling for a merely-close budget. Amber warns at 80%; rose is reserved for over budget.
