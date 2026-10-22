import { act } from '@testing-library/react-native';
import { queryClient } from '../../queryClient';
import { setAuthStatus } from './authMock';

// Sign out in production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
export async function signOut(): Promise<void> {
  await act(() => { queryClient.clear(); setAuthStatus('anon'); });
}
