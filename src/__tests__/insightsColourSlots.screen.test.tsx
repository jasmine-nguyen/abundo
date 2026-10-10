// Insights colour/slot painting (WHIT-402/432): the donut paints each category from its STORED
// colour slot. Captures the slices handed to the pie (../components/SpendingDonut). WHIT-687: drawn
// over the fake server with the shared Insights kit, so the real category mapping (toCategory keeps
// colorSlot) and breakdown reads run.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { PALETTE_CATS } from './insightsColourFixtures';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';

let capturedSlices: { id: string; name: string; color: string; value: number }[] = [];
jest.mock('../components/SpendingDonut', () => ({
  SpendingDonut: (props: { slices: { id: string; name: string; color: string; value: number }[] }) => {
    capturedSlices = props.slices;
    return null;
  },
}));

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

const posted = (n: number) => ({ posted: n, pending: 0 });

beforeEach(() => {
  resetAuth();
  resetAi();
  capturedSlices = [];
  // PALETTE_CATS carry the OLD app-wide colours, and `shopping` carries slot 2 — NOT its seed slot
  // 13 — so the stored path (#b5bb51) and the id fallback (#25cdbd) disagree. That disagreement is
  // the whole point: it reddens if the screen stops forwarding the slot.
  seedInsights(server, {
    breakdown: breakdownWire({ spend: { shopping: posted(80), eatingout: posted(40) } }),
    categories: [...PALETTE_CATS],
  });
});

it('paints the donut slices with the ramp colours, not the old category hues', async () => {
  await renderInsights();
  const shopping = capturedSlices.find((s) => s.id === 'shopping');
  const eatingout = capturedSlices.find((s) => s.id === 'eatingout');
  // slot 2 -> ramp 5. NOT #25cdbd, which is what the id-derived fallback would give — so this
  // assertion is what proves the screen reads the stored slot.
  expect(shopping?.color).toBe('#b5bb51');
  expect(eatingout?.color).toBe('#f98f98'); // slot 0 -> ramp 0
});
