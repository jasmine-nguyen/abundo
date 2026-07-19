// Shared helpers for the donut screen tests — extracted so a change to the rendered node shape or
// the react-native-svg jest stub is a one-file edit, not four.
import { screen } from '@testing-library/react-native';
import type { DonutSlice } from '../../components/SpendingDonut';

// The emphasis opacity lives on the AnimatedG wrapping each testID'd shape (resolved to a plain
// number under the jest SVG stub, which renders svg elements as Views). Walk up from the shape to
// the first ancestor that carries it.
export const opacityOf = (id: string): number => {
  let node: any = screen.getByTestId(`donut-slice-${id}`);
  while (node && node.props?.opacity === undefined) node = node.parent;
  return node.props.opacity;
};

// Minimal slice factory — the id doubles as the display name.
export const sl = (id: string, value: number): DonutSlice => ({ id, name: id, color: '#7aa2f7', value });
