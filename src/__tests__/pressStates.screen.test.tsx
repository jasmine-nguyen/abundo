// WHIT-184 GAP — the "visible press state" DoD on the TransactionRow, which the
// implementer's TransactionRow.screen.test.tsx (labels + tap-to-open) never asserts. The row
// now uses style={({pressed}) => [styles.body, pressed && PRESSED]} (WHIT-717 shared style). We call that
// style function with pressed true/false and flatten it: a revert that drops the pressed
// branch (row feels dead again) fails here. WHIT-843: a filed row is no longer disabled — it
// opens details and takes the same pressed look.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import { pressedStyle } from './support/pressedStyle';
import type { Category } from '../types';
import { PRESSED } from '../theme';

// WHIT-192: the row reads only openPicker from the store; category is a prop.
let mockState: { openPicker: jest.Mock; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));

// WHIT-272: the row now calls useRouter for the detail-page chevron. Stub it so the
// direct-render row still mounts. The chevron uses a STATIC style, so the "exactly one
// function-style node" invariant below is unchanged.
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { TransactionRow } from '../components/TransactionRow';

type Node = { props: { style: unknown; disabled?: boolean } };

beforeEach(() => {
  mockState = { openPicker: jest.fn(), category: makeState({ categories: [cat()] }).category };
});

// The row's Pressable is the only node whose `style` is a function (the pressed-state fn).
function pressable(root: { findAll: (p: (n: Node) => boolean) => Node[] }): Node {
  const hits = root.findAll((n) => typeof n.props?.style === 'function');
  expect(hits.length).toBe(1);
  return hits[0];
}

// WHIT-843: every row body is enabled (unfiled → picker, filed/Income → details), never a disabled look.
it.each([
  { row: 'an unfiled row', category: null },
  { row: 'a filed row', category: 'coffee' },
  { row: 'an Income row', category: 'income' },
])('$row takes the shared pressed style on press and is solid at rest', ({ category }) => {
  const { UNSAFE_root } = render(<TransactionRow t={txn({ transaction_id: 'tx9', category })} category={mockState.category} />);
  const row = pressable(UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] });
  expect(row.props.disabled).toBeFalsy();          // enabled → can enter pressed state
  expect(pressedStyle(row, false).opacity).toBeUndefined(); // at rest: no dim
  const pressed = pressedStyle(row, true);
  expect(pressed.opacity).toBe(PRESSED.opacity);     // pressed: dim
  expect(pressed.transform).toEqual(PRESSED.transform); // pressed: shrink
});
