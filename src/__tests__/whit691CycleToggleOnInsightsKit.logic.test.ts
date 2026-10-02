// WHIT-691 — the Insights cycle-toggle test draws the screen through the shared Insights test kit
// (support/insightsScreen.tsx) instead of its own copy of the context mock, AI slice and render setup.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const FILE = 'insightsCycleToggle.gaps.screen.test.tsx';
const BASELINE_EXPECTS = 19;

const AUTH_MOCK_MODULE = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)/;
const CONTEXT_MOCK_MODULE = /jest\.mock\(\s*['"]\.\.\/context['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/insightsScreen['"]\)\.contextMockModule\(\)/;

const source = () => readFileSync(join(__dirname, FILE), 'utf8');

describe('WHIT-691 the cycle-toggle test runs on the shared Insights kit', () => {
  it('uses the kit for the context mock, AI state, seeding and rendering, with no local copy left', () => {
    const text = source();
    const problems: string[] = [];

    if (!CONTEXT_MOCK_MODULE.test(text)) problems.push('does not mock ../context with the kit contextMockModule()');
    if (!AUTH_MOCK_MODULE.test(text)) problems.push('does not mock ../auth with the shared authMockModule()');
    if (!/useTestQueryClient\(\)/.test(text)) problems.push('no useTestQueryClient()');
    if (!/installFakeServer\(\)/.test(text)) problems.push('no installFakeServer()');
    if (!/\bresetAi\(\)/.test(text)) problems.push('does not reset the AI state with resetAi()');
    if (!/\bresetAuth\(\)/.test(text)) problems.push('does not reset auth with resetAuth()');
    if (!/\bsetAi\(/.test(text)) problems.push('does not populate the coach with setAi()');
    if (!/seedInsights\(\s*server/.test(text)) problems.push('does not seed through seedInsights(server, ...)');
    if (!/await renderInsights\(\)/.test(text)) problems.push('does not render through the kit renderInsights()');

    if (/function renderInsights/.test(text)) problems.push('still defines its own renderInsights');
    if (/requireActual\(\s*['"]\.\.\/context['"]/.test(text)) problems.push('still builds its own partial ../context mock');
    if (/\bmockAi\b/.test(text)) problems.push('still keeps its own mutable mockAi');
    if (/\bmakeClient\b/.test(text)) problems.push('still builds its own query client with makeClient');
    if (/QueryClientProvider/.test(text)) problems.push('still wraps the screen in its own QueryClientProvider');
    if (/server\.seed\(/.test(text)) problems.push('still seeds the fake server by hand');

    expect(problems).toEqual([]);
  });

  it('keeps at least its baseline number of checks', () => {
    const count = source().split('expect(').length - 1;
    expect(count).toBeGreaterThanOrEqual(BASELINE_EXPECTS);
  });
});
