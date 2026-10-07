// A Pressable's style function, run with pressed true/false and flattened — so a suite can check
// a tappable element takes the shared PRESSED style on press and is solid at rest.
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { expect } from '@jest/globals';
import { StyleSheet } from 'react-native';

type StyledNode = { props: { style?: unknown } };

export function pressedStyle(node: StyledNode, pressed: boolean) {
  expect(typeof node.props.style).toBe('function');
  return StyleSheet.flatten((node.props.style as (x: { pressed: boolean }) => unknown)({ pressed })) as {
    opacity?: number;
    transform?: unknown;
  };
}
