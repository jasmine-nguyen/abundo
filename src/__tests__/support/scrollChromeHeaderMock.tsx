// A plain stand-in for the scrolling header chrome: renders the title, the right-hand button and
// the content, without the native scroll/animation geometry. Use it as
//   jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
import React from 'react';
import { Text, View } from 'react-native';

function ScrollChromeHeader({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return <View><Text>{title}</Text>{right}{children}</View>;
}

export function scrollChromeHeaderMockModule() {
  return { ScrollChromeHeader };
}
