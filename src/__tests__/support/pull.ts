// A user's pull-to-refresh on the rendered screen: fire the RefreshControl's onRefresh, then wait
// for its spinner to clear.
import { expect } from '@jest/globals';
import { screen, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

export const pullControl = () => screen.UNSAFE_getByType(RefreshControl);

export async function pullAndSettle() {
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
}
