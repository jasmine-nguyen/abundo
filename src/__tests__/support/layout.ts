// Layout queries over the rendered tree: a node's flattened style, its text, and the nearest
// host View holding two nodes (to tell "side by side" from "stacked").
import { StyleSheet } from 'react-native';
import { expect } from '@jest/globals';
import { fireEvent, screen } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

export const styleOf = (node: Pick<TestInstance, 'props'>) => StyleSheet.flatten(node.props.style) ?? {};

export const textOf = (node: TestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

// Every rendered element of one native type, e.g. 'RCTScrollView' (a ScrollView, SectionList or
// FlatList), 'RCTSwitch' or 'Modal'.
export const hostsOfType = (type: string, root: TestInstance = screen.container) =>
  root.queryAll((node) => node.type === type);

// The rendered SectionLists / FlatLists: scrollers that pull their rows through getItem.
export const virtualLists = () => hostsOfType('RCTScrollView').filter((list) => list.props.getItem);

// Whether `node` is `host` or sits somewhere inside it.
export function isWithin(node: TestInstance, host: TestInstance) {
  for (let n: TestInstance | null = node; n; n = n.parent) if (n === host) return true;
  return false;
}

// The element directly above `node`.
export function hostParent(node: TestInstance) {
  return node.parent!;
}

export function sharedHost(node: TestInstance, other: TestInstance) {
  for (let host = node.parent; host; host = host.parent) {
    if (isWithin(other, host)) return host;
  }
  throw new Error('no shared ancestor');
}

// The title bar (Header) has no bottom edge at the top, draws one once `scroller` scrolls down,
// and drops it again back at the top.
export async function expectScrollEdge(scroller: TestInstance) {
  const edge = () => styleOf(screen.getByTestId('header-wrap')).borderBottomColor;
  expect(edge()).toBe('transparent');
  await fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 0, y: 40 } } });
  expect(edge()).not.toBe('transparent');
  await fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  expect(edge()).toBe('transparent');
}

// A large-text row stacks: name and amount aren't side by side, and nothing above the amount
// caps it at the side-by-side 45% width.
export function expectStacked(name: TestInstance, amount: TestInstance) {
  expect(styleOf(sharedHost(name, amount)).flexDirection).not.toBe('row');
  for (let host: TestInstance | null = amount.parent; host; host = host.parent) {
    if (typeof host.type === 'string') expect(styleOf(host).maxWidth).not.toBe('45%');
  }
}
