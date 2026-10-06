// No test may mock api.ts in any form (bare auto-mock, factory mock, jest.doMock): a mock skips
// the real request code (src/api.ts). Suites use `installFakeServer()` instead.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const API_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+api['"]/m;

function mocksApi(file: string): boolean {
  return API_MOCK.test(readFileSync(join(__dirname, file), 'utf8'));
}

describe('no test mocks the api', () => {
  it('no test file mocks the api', () => {
    expect(testFiles(__dirname).filter(mocksApi)).toEqual([]);
  });

  it('the pattern catches bare, factory and doMock mocks of the api and ignores comments and look-alikes', () => {
    expect(`jest.mock('../api');`).toMatch(API_MOCK);
    expect(`import x from 'y';\n  jest.mock("../../api")`).toMatch(API_MOCK);
    expect(`jest.mock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`jest.mock('../api', () => ({\n  fetchX: () => mockFetchX(),\n}));`).toMatch(API_MOCK);
    expect(`jest.doMock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`// used instead of jest.mock('../api')`).not.toMatch(API_MOCK);
    expect(`jest.mock('../apiWire');`).not.toMatch(API_MOCK);
  });

  // [A1] WHIT-640 QA — layouts the factory form really takes, and near-miss module names.
  it('the pattern catches tab-indented, line-broken and deep-path mocks and skips other api* modules', () => {
    expect(`\tjest.mock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`jest.mock(\n  '../api',\n  () => ({ fetchX: jest.fn() }),\n);`).toMatch(API_MOCK);
    expect(`jest.mock("../../../api", () => ({}));`).toMatch(API_MOCK);
    expect(`  jest.doMock("../api");`).toMatch(API_MOCK);
    expect(`jest.mock('../apiError', () => ({}));`).not.toMatch(API_MOCK);
    expect(`jest.mock('../api-client');`).not.toMatch(API_MOCK);
    expect(`jest.mock('./support/api');`).not.toMatch(API_MOCK);
    expect(`const hint = "jest.mock('../api')";`).not.toMatch(API_MOCK);
  });
});
