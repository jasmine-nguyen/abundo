// ABU-114: async-storage holds the Cognito session and the Ask Abundo consent. Expo 58 pins it
// to 2.2.0, so without the expo.install.exclude entry the next `expo install --fix` would
// downgrade it to v2 and users would lose that saved data.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ASYNC_STORAGE = '@react-native-async-storage/async-storage';
const readJson = (repoRelative: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', repoRelative), 'utf8'));
const major = (version: string) => Number(version.replace(/^[^\d]*/, '').split('.')[0]);

describe('async-storage stays on v3', () => {
  // [A2]
  it('is installed on v3 and excluded from expo install while Expo pins a lower major', () => {
    const pkg = readJson('package.json');
    const expoPin: string = readJson('node_modules/expo/bundledNativeModules.json')[ASYNC_STORAGE];
    expect(major(readJson(`node_modules/${ASYNC_STORAGE}/package.json`).version)).toBeGreaterThanOrEqual(3);
    expect(major(pkg.dependencies[ASYNC_STORAGE])).toBeGreaterThanOrEqual(3);
    if (major(expoPin) >= 3) return;
    expect(pkg.expo.install.exclude).toContain(ASYNC_STORAGE);
  });
});
