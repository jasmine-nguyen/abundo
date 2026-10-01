// WHIT-324 (qa adversarial) — the Insights screen gate `(earned > 0 || rows.length > 0)` at its
// boundary. The implementer's InsightsScreen suite pins earned-only (income, no rows) and the
// both-zero null case, but NOT the mirror branch: earned EXACTLY 0 WITH spend rows — the
// "spent before payday landed" case where the OR passes on rows.length, and the card must show a
// deficit of the whole spend. WHIT-687: drawn over the fake server with the shared Insights kit.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

const server = installFakeServer();
useTestQueryClient();

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle', recent: 0 }];

beforeEach(() => {
  resetAuth();
  resetAi();
});

describe('earned-vs-spent gate — earned exactly 0 with spend rows [G5]', () => {
  // The OR's rows.length branch: earned is 0 (payday hasn't landed) but there IS spend → the card
  // shows, reading a deficit of the whole spend. Guards that a future `earned > 0` tightening of
  // the gate wouldn't silently drop the card on a spend-only cycle.
  it('shows the card as a full deficit when earned is 0 but there is spend', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 100, pending: 0 } }, earned: 0 }), categories: CATS });
    await renderInsights();
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('0%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$100 deficit');
  });

  // The exact seam: 0 earned AND 0 rows → the OR is false → card absent (already asserted in the
  // implementer's suite, re-pinned here beside its mirror so the boundary pair reads together).
  it('hides the card when earned is 0 and there are no spend rows', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 0 }), categories: CATS });
    await renderInsights();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
  });
});
