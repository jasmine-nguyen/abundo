// WHIT-687 slice 2 — acceptance: the shared Insights test kit draws the real Insights tab over the
// fake server, and the four smaller Insights tests stop faking the screen data code.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';
import { GROCERIES_RECORD } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetAi();
});

describe('the Insights tab drawn over the fake server with the shared kit', () => {
  it('shows the real earned-vs-spent read and the income source from the /breakdown reply', async () => {
    seedInsights(server, {
      breakdown: breakdownWire({
        spend: { groceries: { posted: 400, pending: 100 } },
        earned: 3000,
        income: { salary: { posted: 3000, pending: 0 } },
      }),
      categories: [
        { ...GROCERIES_RECORD, recent: 0, colorSlot: 1 },
        { id: 'salary', name: 'Salary', icon: 'briefcase', bucket: 'Income', recent: 0, colorSlot: 2 },
      ],
    });

    await renderInsights();

    expect(await screen.findByText('Groceries')).toBeTruthy();
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$2,500 surplus');

    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(await screen.findByText('Salary')).toBeTruthy();
  });
});

// Built from pieces so this file never matches its own scan.
const SCREEN_DATA_MOCK = new RegExp(String.raw`^\s*jest\.(mock|doMock)\(\s*['"](\.\./)+(src/)?` + 'quer' + `ies['"]`, 'm');
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('the four smaller Insights tests use the real screen data code', () => {
  it('none of them fakes the screen data code, and the three screen tests draw over the fake server', () => {
    const files = [
      'earnedVsSpentGate.screen.test.tsx',
      'insightsIncomePalette.screen.test.tsx',
      'insightsScreenGaps.screen.test.tsx',
      'insightsSegmentedControl.gaps.screen.test.tsx',
    ];
    expect(files.filter((file) => SCREEN_DATA_MOCK.test(read(file)))).toEqual([]);

    const moved = files.slice(0, 3);
    expect(moved.filter((file) => !/installFakeServer\(\)/.test(read(file)))).toEqual([]);
    expect(moved.filter((file) => !read(file).includes('./support/insightsScreen'))).toEqual([]);
  });
});
