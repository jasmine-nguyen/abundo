// WHIT-712 QA — a budget row is full-strength at rest and dims + shrinks while pressed
// (DESIGN.md Buttons). Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen, fireEvent, act } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// The row's Pressable host view: the nearest ancestor of the name that handles touches.
function rowHost() {
  let node = screen.getByText('Cafes & Coffee').parent;
  while (node && !node.props.onResponderRelease) node = node.parent;
  return node!;
}
const rowStyle = () => StyleSheet.flatten(rowHost().props.style) as { opacity?: number; transform?: { scale?: number }[] };
const touch = { nativeEvent: { timestamp: 0, pageX: 0, pageY: 0, touches: [], changedTouches: [] }, persist: () => {}, currentTarget: { measure: () => {} } };

// [A5] (P1) at rest the row is full-strength; press-in dims + shrinks it inside DESIGN.md's range.
it('[A5] a pressed budget row dims and shrinks', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 50, pending: 0 } });
  await renderLoadedBudgetsWithQueries();
  expect(rowStyle().opacity ?? 1).toBe(1);

  await act(async () => { fireEvent(rowHost(), 'responderGrant', touch); });
  const pressed = rowStyle();
  expect(pressed.opacity).toBeGreaterThanOrEqual(0.6);
  expect(pressed.opacity).toBeLessThanOrEqual(0.85);
  const scale = pressed.transform?.find((t) => t.scale !== undefined)?.scale;
  expect(scale).toBeGreaterThanOrEqual(0.92);
  expect(scale).toBeLessThanOrEqual(0.96);
});
