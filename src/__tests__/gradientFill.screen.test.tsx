// WHIT-615 — iOS react-native-svg keeps a shape's `%` sizes from its first draw, so a gradient
// sized with `%` (or rounded with `rx`) stops short when its view grows. The shared fill must
// stretch a 0-1 viewBox instead and take its corners from a clipping wrapper View.
import { it, expect } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { GradientFill } from '../components/ui';
import { styleOf } from './support/layout';

const LENGTH_PROPS = ['width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2'];

async function expectViewBoxStretch(element: React.ReactElement, borderRadius: number | undefined) {
  const { container } = await render(element);
  const nodes = container.queryAll(() => true);

  for (const node of nodes) {
    for (const prop of LENGTH_PROPS) {
      const value = node.props[prop];
      if (typeof value === 'string') expect(value).not.toMatch(/%$/);
    }
    expect(node.props.rx).toBeUndefined();
    expect(node.props.ry).toBeUndefined();
  }

  const svg = nodes.find((node) => node.props.viewBox === '0 0 1 1');
  expect(svg?.props.preserveAspectRatio).toBe('none');

  const wrapper = nodes.find((node) => node.props.pointerEvents === 'none');
  if (!wrapper) throw new Error('no clipping wrapper');
  const wrapperStyle = styleOf(wrapper);
  expect(wrapperStyle.overflow).toBe('hidden');
  expect(wrapperStyle.borderRadius).toBe(borderRadius);
}

it('GradientFill stretches a 0-1 viewBox, with no % sizes or rx, and clips its own corners', async () => {
  await expectViewBoxStretch(
    <GradientFill id="t" x2={1} y2={1} stops={[[0, '#000'], [1, '#fff']]} borderRadius={24} />,
    24,
  );
});
