// WHIT-836 QA: one category palette on every screen. categoryOnePalette.logic.test.ts pins
// toCategory; this proves the screens and the store's writers actually paint that colour.
// The fixture's `shopping` holds slot 2, NOT its seed slot, so the slot colour (#b5bb51), the id
// fallback (#25cdbd) and the server's old hex (#73daca) all differ: a wrong path can't pass.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act, screen, within } from '@testing-library/react-native';
import { Icon } from '../icons';
import { chartCategoryColor } from '../chartColors';
import { toCategory } from '../model';
import { useAppContext } from '../context';
import type { Category } from '../types';
import { queryClient } from '../queryClient';
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper } from './support/renderWithApp';
import { renderBudgets } from './support/budgetsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { PALETTE_CATS } from './insightsColourFixtures';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
import { resetAuth } from './support/authMock';

const server = installFakeServer();
const SHOPPING_SLOT_COLOUR = chartCategoryColor('shopping', { slot: 2 });

beforeEach(() => resetAuth());

describe('Budgets paints a category in its Insights colour', () => {
  it('[A1] a slotted category\'s row icon is its slot colour, not the id fallback or the server hex', async () => {
    expect(SHOPPING_SLOT_COLOUR).not.toBe(chartCategoryColor('shopping'));
    seedBudgetsTab(server, { shopping: { target: 100, posted: 30, pending: 0 } }, [...PALETTE_CATS]);
    renderBudgets();
    await screen.findByText('Shopping');

    const icon = within(screen.getByTestId('budget-row-shopping')).UNSAFE_getByType(Icon);
    expect(icon.props.color).toBe(SHOPPING_SLOT_COLOUR);
  });
});

describe('the store\'s category writers colour through toCategory', () => {
  // A custom category whose stored slot paints a different colour from its id fallback.
  const WINE = { id: 'wine', name: 'Wine', bucket: 'Lifestyle', icon: 'glass', parent: null, color: '#ff0000', colorSlot: 7 };
  const wineColour = chartCategoryColor('wine', { slot: 7 });
  const cachedWine = () => queryClient.getQueryData<Category[]>(['categories'])?.find((c) => c.id === 'wine');

  beforeEach(() => {
    queryClient.clear();
    queryClient.setQueryData(['categories'], []);
  });
  afterEach(() => queryClient.clear());

  it('[A2] create and rename both keep the server-assigned slot colour in the cache', async () => {
    expect(wineColour).not.toBe(chartCategoryColor('wine'));
    const { result } = renderHook(() => useAppContext(), { wrapper: appProviderWrapper });

    server.once('POST', '/categories', { body: WINE });
    await act(async () => { await result.current.createCategoryInline({ name: 'Wine', bucket: 'Lifestyle', icon: 'glass', parent: null }); });
    expect(cachedWine()?.color).toBe(wineColour);

    queryClient.setQueryData(['categories'], [toCategory(WINE)]);
    server.once('PATCH', '/categories/wine', { body: { ...WINE, name: 'Natural Wine' } });
    await act(async () => { await result.current.saveCategory('wine', { name: 'Natural Wine', bucket: 'Lifestyle', icon: 'glass' }); });
    expect(cachedWine()).toMatchObject({ name: 'Natural Wine', color: wineColour });
  });
});
