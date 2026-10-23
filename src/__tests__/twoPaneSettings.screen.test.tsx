// ABU-112 — Settings on a wide screen (the iPhone Duo's inner screen): Categories, Automation rules
// and Loan details open beside the settings list instead of as a new page; saving the loan closes
// the pane; folding reopens the open page full screen. Narrow screens push the pages, as before.
// Real screen + AppProvider over the fake server; only the window-width check is switched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, WithApp } from './support/renderWithApp';
import { resetListTabs } from './support/listTabsScreen';
import { routerSpies, setFocused } from './support/routerMock';
import { fillLoanForm, VALID_LOAN_FORM } from './support/loanForm';
import { styleOf } from './support/layout';
import { GROCERIES_TOP } from './support/categories';
import { C, tint } from '../theme';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
jest.mock('../auth', () => ({ ...require('./support/authMock').authMockModule(), getCurrentUser: () => null }));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Settings from '../../app/settings';

const server = installFakeServer();
useTestQueryClient();

const EMPTY_PROMPT = 'Choose a setting';
const RULES_SHOWN = 'Add a rule';
const LOAN_SHOWN = 'Save loan details';
const SELECTED_WASH = tint(C.accentAlt, 0.1);

const pushed = () => routerSpies.push.mock.calls.map(([href]) => href);

async function drawAndOpen(row: string) {
  const view = await renderWithApp(<Settings />);
  await fireEvent.press(screen.getByText(row));
  return view;
}

beforeEach(() => {
  resetListTabs(server);
  mockWide = true;
});

describe('wide screen', () => {
  it('opens each page beside the settings list, highlighted, without a new page or a second back arrow', async () => {
    await renderWithApp(<Settings />);
    expect(screen.getByText(EMPTY_PROMPT)).toBeTruthy();

    await fireEvent.press(screen.getByText('Automation rules'));
    expect(await screen.findByText(RULES_SHOWN)).toBeTruthy();
    expect(screen.queryByText(EMPTY_PROMPT)).toBeNull();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getAllByLabelText('Back')).toHaveLength(1);
    expect(styleOf(screen.getByTestId('settings-row-rules')).backgroundColor).toBe(SELECTED_WASH);
    expect(styleOf(screen.getByTestId('settings-row-category')).backgroundColor).not.toBe(SELECTED_WASH);

    await fireEvent.press(screen.getByText('Categories'));
    expect(await screen.findByText(GROCERIES_TOP.name)).toBeTruthy();
    expect(screen.queryByText(RULES_SHOWN)).toBeNull();

    await fireEvent.press(screen.getByText('Loan details'));
    expect(await screen.findByText(LOAN_SHOWN)).toBeTruthy();
    expect(screen.queryByText(GROCERIES_TOP.name)).toBeNull();
    expect(pushed()).toEqual([]);
  });

  it('a category edit still opens full screen from the pane', async () => {
    await drawAndOpen('Categories');

    await fireEvent.press(await screen.findByText(GROCERIES_TOP.name));
    await fireEvent.press(screen.getByText('New category'));

    expect(pushed()).toEqual([`/category/edit?categoryId=${GROCERIES_TOP.id}`, '/category/edit']);
  });

  it.each([
    ['succeeds', false, false],
    ['fails', true, true],
  ])('when the loan save %s from the pane (fails: %p), the form stays open: %p, and it never goes back', async (_label, failSave, formStays) => {
    if (failSave) server.once('PUT', '/loanfacts', { status: 500 });
    await drawAndOpen('Loan details');
    await screen.findByText(LOAN_SHOWN);
    await fillLoanForm(VALID_LOAN_FORM);

    await refreshInAct(() => fireEvent.press(screen.getByText(LOAN_SHOWN)));

    await waitFor(() => expect(server.sent('PUT', '/loanfacts')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(LOAN_SHOWN) !== null).toBe(formStays));
    expect(screen.queryByText(EMPTY_PROMPT) !== null).toBe(!formStays);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('folding to a narrow screen with a page open reopens it full screen', async () => {
    const view = await drawAndOpen('Automation rules');
    await screen.findByText(RULES_SHOWN);
    setFocused(true);

    mockWide = false;
    await refreshInAct(() => view.rerender(<WithApp><Settings /></WithApp>));

    expect(pushed()).toEqual(['/rules']);
    expect(screen.queryByText(RULES_SHOWN)).toBeNull();
  });
});

it.each([
  ['Categories', '/category'],
  ['Automation rules', '/rules'],
  ['Loan details', '/loan'],
])('narrow screen: %s opens %s as a new page, as today', async (row, href) => {
  mockWide = false;
  await drawAndOpen(row);

  expect(pushed()).toEqual([href]);
  expect(screen.queryByText(EMPTY_PROMPT)).toBeNull();
});
