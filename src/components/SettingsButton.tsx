import React from 'react';
import { useRouter } from 'expo-router';
import { HeaderIconButton } from './ui';

// WHIT-495: the header gear that replaces the Settings tab. Sits in the top-left header slot on
// every tab; pushes the /settings route (now a root screen).
export function SettingsButton() {
  const router = useRouter();
  return <HeaderIconButton icon="navSettings" iconSize={20} accessibilityLabel="Settings" onPress={() => router.push('/settings')} />;
}
