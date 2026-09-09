// WHIT-508 — [A20] the client's abort budget must outlast the server's own work budget.
//
// The server stops its write loop at APPLY_RULES_TIME_BUDGET_SECONDS and then answers with an
// honest account of what it wrote. The client aborts the request at APPLY_RULES_TIMEOUT_MS. If the
// client's number ever slides under the server's, a run that SUCCEEDED — up to 300 charges
// committed — is torn down client-side and the user is shown "Couldn't finish. Some charges may
// already have been filed." The write cap has a parity test (applyRulesCap.logic.test.ts); the
// clock did not, and it is the same class of silent drift.
//
// Headroom, not bare inequality: the server's clock starts BEFORE the BankSync rules read and the
// whole-history scan, and the response still has to serialise and cross API Gateway afterwards.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const readSource = (repoRelative: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', repoRelative), 'utf8');

describe('the apply-rules request budget outlasts the server budget', () => {
  it('gives the server its full time budget plus headroom before the client aborts', () => {
    const client = readSource('src/api.ts').match(/^const APPLY_RULES_TIMEOUT_MS = ([\d_]+);/m);
    const server = readSource('lambda_api/constants.py')
      .match(/^APPLY_RULES_TIME_BUDGET_SECONDS\s*=\s*(\d+)/m);

    // A throw here means one of the two constants was renamed or moved. Fix the mirror — do not
    // loosen the regex, or the client quietly starts aborting runs the server is completing.
    expect(client).not.toBeNull();
    expect(server).not.toBeNull();

    const clientMs = Number(client![1].replace(/_/g, ''));
    const serverMs = Number(server![1]) * 1000;

    expect(clientMs).toBeGreaterThan(serverMs);
    expect(clientMs - serverMs).toBeGreaterThanOrEqual(10_000);
  });
});
