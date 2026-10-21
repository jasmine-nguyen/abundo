// ABU-43: the server reply words the app acts on, shared with tests/lambda_api/test_api_response_contract.py.
import type { ApplyRulesJobStatus } from '../../api';

export const apiContract = require('../../../tests/fixtures/api_response_contract.json') as {
  batchCategory: {
    request: { updates: { id: string; category: string; account_id?: string }[] };
    response: { results: { id: string; status: string }[] };
  };
  jobStatuses: Record<ApplyRulesJobStatus, ApplyRulesJobStatus>;
};
export const UPDATED = apiContract.batchCategory.response.results[0].status;
