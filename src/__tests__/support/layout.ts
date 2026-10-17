// Layout queries over the rendered tree: a node's flattened style, its text, and the nearest
// host View holding two nodes (to tell "side by side" from "stacked").
import { StyleSheet } from 'react-native';
import { expect } from '@jest/globals';
import type { ReactTestInstance } from 'react-test-renderer';

export const styleOf = (node: Pick<ReactTestInstance, 'props'>) => StyleSheet.flatten(node.props.style) ?? {};

export const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

// The nearest host (rendered) element above `node`.
export function hostParent(node: ReactTestInstance) {
  let host = node.parent!;
  while (typeof host.type !== 'string') host = host.parent!;
  return host;
}

export function sharedHost(node: ReactTestInstance, other: ReactTestInstance) {
  for (let host = node.parent; host; host = host.parent) {
    if (typeof host.type !== 'string') continue;
    if (host.findAll((n) => n === other).length > 0) return host;
  }
  throw new Error('no shared ancestor');
}

// A large-text row stacks: name and amount aren't side by side, and nothing above the amount
// caps it at the side-by-side 45% width.
export function expectStacked(name: ReactTestInstance, amount: ReactTestInstance) {
  expect(styleOf(sharedHost(name, amount)).flexDirection).not.toBe('row');
  for (let host: ReactTestInstance | null = amount.parent; host; host = host.parent) {
    if (typeof host.type === 'string') expect(styleOf(host).maxWidth).not.toBe('45%');
  }
}
