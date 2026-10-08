// A user's pull-to-refresh on the rendered screen: fire the RefreshControl's onRefresh, then wait
// for its spinner to clear.
import { expect } from '@jest/globals';
import { screen, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

export const pullControl = () => screen.UNSAFE_getByType(RefreshControl);

// The rendered tree as a string. A ScrollView's refreshControl prop is a React element that links
// back into the renderer (circular), so a plain JSON.stringify of a pullable screen throws.
export const screenJson = () =>
  JSON.stringify(screen.toJSON(), (key, value) => (key === 'refreshControl' ? undefined : value));

export async function pullAndSettle() {
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
}
