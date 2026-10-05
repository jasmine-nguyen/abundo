// A passthrough ScrollChromeHeader for screen tests: title, right slot and children in a plain
// View, no scroll/animation chrome. Usage:
//   jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
import React from 'react';
import { View, Text } from 'react-native';

export function scrollChromeHeaderMockModule() {
  return {
    ScrollChromeHeader: ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
      <View><Text>{title}</Text>{right}{children}</View>
    ),
  };
}
