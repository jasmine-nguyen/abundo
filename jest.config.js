// Two test projects:
//
//   logic  – pure functions over app state (pay-cycle math, budget/categorize
//            selectors, mappers). No React Native, so it runs on a plain node
//            env with just the babel-preset-expo transform. Fast + rock-solid;
//            this is the regression gate that must stay green on every merge.
//
//   screen – component render/interaction tests via React Native Testing Library,
//            using the RN jest preset. Heavier; exercises the actual UI widgets
//            (rows, sheets) seeded from the QA agent's scenarios.
//
// Both are run by `npm test` (jest picks up all projects). Filter with
// `jest --selectProjects logic`.

const RN_TRANSFORM_IGNORE = [
  'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
];

module.exports = {
  // Coverage floor (a ratchet — raise it as more of the client gets tested, like the
  // Python 72% gate). It's a REGRESSION backstop, not a quality measure: a green
  // coverage number never proves a test is meaningful (that's the fail-on-revert
  // check code-critic runs). Current ~33% lines; floor sits a few points under so a
  // new feature can't quietly drop coverage, without demanding a legacy-screen backfill.
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/__tests__/**'],
  // `text` prints the per-file table into the CI log; `json-summary` writes
  // coverage/coverage-summary.json, which the CI "Coverage summary" step renders
  // onto the GitHub run summary page (so you don't have to open the job log).
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    global: { statements: 30, branches: 42, functions: 22, lines: 30 },
  },
  projects: [
    {
      displayName: 'logic',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.logic.test.{ts,tsx}'],
      transform: {
        '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }],
      },
      transformIgnorePatterns: RN_TRANSFORM_IGNORE,
      clearMocks: true,
    },
    {
      displayName: 'screen',
      preset: 'react-native',
      testMatch: ['<rootDir>/src/**/*.screen.test.{ts,tsx}'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
      transformIgnorePatterns: RN_TRANSFORM_IGNORE,
      clearMocks: true,
    },
  ],
};
