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
// Scripts (package.json):
//   npm test         → the fast `logic` project only — the everyday inner loop (~5s).
//   npm run test:screen → just the heavy `screen` project.
//   npm run test:all → BOTH projects — used by CI and before a PR.
// test:screen / test:all pass --workerIdleMemoryLimit so a worker is recycled between
// files (its RN module graph can't accumulate and OOM-crash mid-run); CI also caps
// --maxWorkers. Filter any of them further with a test-name/path argument.

const RN_TRANSFORM_IGNORE = [
  'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
];

module.exports = {
  // The set of source files coverage is measured over. `collectCoverageFrom` also forces
  // UNCOVERED files into every run's report, so each CI shard carries the full codebase as
  // its denominator — that's what makes the per-shard reports safe to merge into a total.
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/__tests__/**'],
  // The 100+ React-Native `screen` suites boot the whole RN module graph; measuring them
  // all under coverage in ONE process OOM-crashes a worker under istanbul and hangs ~9 min
  // under v8's source remap. So CI (and scripts/coverage-run-local.sh) SHARD the screen
  // project across jobs — each measures its slice, then scripts/coverage-merge-check.js
  // merges them and enforces the floor. v8 is the less memory-hungry provider and produces
  // the mergeable json below.
  coverageProvider: 'v8',
  // Default reporters for a bare `jest --coverage`: `text` prints the per-file table and
  // `json` writes the istanbul-shaped coverage-final.json. NOTE the CI shard steps and
  // scripts/coverage-run-local.sh pass `--coverageReporters=json`, which OVERRIDES this
  // list — the merge only needs coverage-final.json, so json is the one that must be here.
  coverageReporters: ['text', 'json'],
  // NOTE: no `coverageThreshold` here on purpose. Jest's built-in threshold gates a SINGLE
  // run, so under sharding each shard would self-fail against its own partial slice. The
  // floor (statements 30 / branches 42 / functions 22 / lines 30) is enforced on the MERGED
  // total instead — see scripts/coverage-merge-check.js, the one source of truth for it.
  projects: [
    {
      displayName: 'logic',
      testEnvironment: 'node',
      // Pure-function tests: app-state logic under src/, plus the node CI helpers under
      // scripts/ (e.g. the coverage-merge-check gate) — both run on the plain node env.
      testMatch: [
        '<rootDir>/src/**/*.logic.test.{ts,tsx}',
        '<rootDir>/scripts/**/*.test.js',
      ],
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
