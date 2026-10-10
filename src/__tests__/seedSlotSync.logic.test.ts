// WHIT-415 — the CROSS-LANGUAGE guard the change shipped without.
//
// The card moved two slots in shared/repository_category.py. Every client test that "mirrors the
// server seed" is a hand copy, so all of them stayed green against the OLD table until someone
// remembered to retype them — the drift WHIT-406 tracks. This file removes the mirror: it parses
// the real .py and asserts the CLIENT's resolution of it. Change the Python seed without thinking
// and these redden.
import { describe, it, expect } from '@jest/globals';
import { ASSIGNMENT_ORDER, chartCategoryColor } from '../chartColors';
import { readServerSeedSlots } from './serverSeedSlots';

const SERVER_SLOTS = readServerSeedSlots();
/** {id -> the RAMP POSITION the client resolves that server slot to}. */
const SERVER_RAMP = Object.fromEntries(
  Object.entries(SERVER_SLOTS).map(([id, slot]) => [id, ASSIGNMENT_ORDER[slot]]),
) as Record<string, number>;

describe('[A4] the seeded store paints 13 distinct, well-spaced colours', () => {
  it('gives every built-in its own hex', () => {
    const painted = Object.entries(SERVER_SLOTS).map(([id, slot]) => chartCategoryColor(id, { slot }));
    expect(new Set(painted).size).toBe(13);
  });

  it('[A5] Eating Out / Health / Coffee are NOT three neighbouring hues — the card', () => {
    // The reported bug: as the top three by spend they painted as three near-identical salmons.
    // Expressed as the PROPERTY, computed from the .py — not as "coffee's slot is 9", which a
    // future re-shuffle would just retype.
    const warmTrio = ['eatingout', 'health', 'coffee'].map((id) => SERVER_RAMP[id]).sort((a, b) => a - b);
    expect(warmTrio[2] - warmTrio[0]).toBeGreaterThan(2);
    // and nothing else may creep into the salmon end (ramp 0-2) to re-form a trio
    const salmonEnd = Object.entries(SERVER_RAMP).filter(([, p]) => p <= 2).map(([id]) => id);
    expect(salmonEnd.sort()).toEqual(['eatingout', 'health']);
  });
});
