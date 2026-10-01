// WHIT-687 slice 1 — the Ask button, chat pop-up and the advice card's "Ask a follow-up" suites
// draw over the fake server with the real screen data code, instead of hand-made query stand-ins.
// Each is off the noQueriesMock exceptions list and pinned in the noAutoMockApi baselines.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SUITES = [
  'aiCoachFollowUp.screen.test.tsx',
  'askButton.screen.test.tsx',
  'chatSheet.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/;
const AUTH_MOCK_MODULE = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowedBlock(): string {
  const text = source('noQueriesMock.logic.test.ts');
  const start = text.indexOf('const ALLOWED');
  return text.slice(start, text.indexOf(']);', start));
}

describe('WHIT-687 chat suites run on the fake server', () => {
  it('each chat suite runs the real screen data code over the fake server and is pinned in both guards', () => {
    const allowed = allowedBlock();
    const baselines = source('noAutoMockApi.logic.test.ts');

    const problems = CHAT_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/renderWithQueries\(/.test(text)) found.push(`${file}: does not draw via renderWithQueries`);
      if (!AUTH_MOCK_MODULE.test(text)) found.push(`${file}: does not use the shared authMockModule()`);
      if (allowed.includes(`'${file}'`)) found.push(`${file}: still on the noQueriesMock ALLOWED list`);
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the Ask pill look-only check is gone, the budget-line check stays, and the advice card keeps the real context helpers', () => {
    const askButton = source('askButton.screen.test.tsx');
    const chatSheet = source('chatSheet.screen.test.tsx');
    const aiCoach = source('aiCoachFollowUp.screen.test.tsx');

    const problems: string[] = [];
    if (askButton.includes(['fills with the shared', 'gradient'].join(' '))) problems.push('askButton: gradient/shadow test still there');
    if (askButton.includes('shadowOpacity')) problems.push('askButton: still checks the shadow');
    if (!askButton.includes('tapping it opens the chat')) problems.push('askButton: lost the opens-the-chat test');
    if (!chatSheet.includes('the answer card budget line')) problems.push('chatSheet: lost the budget-line test');
    if (!/budget line[\s\S]*renderWithQueries\(\s*<ChatAnswer/.test(chatSheet)) problems.push('chatSheet: budget-line ChatAnswer not drawn via renderWithQueries');
    if (!/jest\.requireActual\(['"]\.\.\/context['"]\)/.test(aiCoach)) problems.push('aiCoachFollowUp: context mock drops the real helpers');
    if (!aiCoach.includes("seed: 'You are pacing well this cycle.'")) problems.push('aiCoachFollowUp: lost the seeded follow-up check');

    expect(problems).toEqual([]);
  });
});
