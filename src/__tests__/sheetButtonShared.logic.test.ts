// WHIT-760 — every plain sheet button in Overlays.tsx is the one shared SheetButton.
//
// A change to the sheet button's look must happen in one place. Only two buttons stay hand-built
// on purpose: 'rule-submit' (colours follow canSave) and 'goal-balance-save' (disabled + fades
// while saving).
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '../components/Overlays.tsx'), 'utf8');

function withoutSheetButton(text: string): string {
  const start = text.indexOf('function SheetButton(');
  if (start === -1) return text;
  const end = text.indexOf('\n}\n', start);
  return text.slice(0, start) + text.slice(end + 3);
}

function handBuiltButtonTestIds(text: string): (string | null)[] {
  // A Pressable's own props run from `<Pressable` up to its first child or closing tag.
  const openTags = text.split(/<Pressable\b/).slice(1).map((chunk) => chunk.split(/<(?:Text|View|\/Pressable)\b/)[0]);
  return openTags
    .filter((tag) => /styles\.btn\b/.test(tag))
    .map((tag) => tag.match(/testID="([^"]+)"/)?.[1] ?? null);
}

describe('sheet buttons share one SheetButton', () => {
  it('only the two special buttons are still hand-built outside SheetButton', () => {
    const rest = withoutSheetButton(source);
    expect(handBuiltButtonTestIds(rest).sort()).toEqual(['goal-balance-save', 'rule-submit']);
    expect(rest).not.toMatch(/styles\.btnGhost/);
  });
});
