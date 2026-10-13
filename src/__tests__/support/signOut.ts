import { act } from '@testing-library/react-native';
import { queryClient } from '../../queryClient';
import { setAuthStatus } from './authMock';

// Sign out in production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
export function signOut(): void {
  act(() => { queryClient.clear(); setAuthStatus('anon'); });
}
