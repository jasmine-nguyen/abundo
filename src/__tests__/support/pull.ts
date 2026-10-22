// A user's pull-to-refresh on the rendered screen: fire the RefreshControl's onRefresh, then wait
// for its spinner to clear.
import { expect } from '@jest/globals';
import { screen, act, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { RefreshControlProps } from 'react-native';

// The RefreshControl isn't a rendered element of its own: it rides on its ScrollView as a prop.
export function pullControl() {
  const [scroller] = screen.container.queryAll((node) => node.props.refreshControl);
  if (!scroller) throw new Error('no pull-to-refresh control on screen');
  return scroller.props.refreshControl as ReactElement<RefreshControlProps & { onRefresh: () => void }>;
}

// The rendered tree as a string. A ScrollView's refreshControl prop is a React element that links
// back into the renderer (circular), so a plain JSON.stringify of a pullable screen throws.
export const screenJson = () =>
  JSON.stringify(screen.toJSON(), (key, value) => (key === 'refreshControl' ? undefined : value));

export async function pullAndSettle() {
  await act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
}
