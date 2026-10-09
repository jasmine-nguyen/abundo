// Every endpoint's request (method, path, time limit, body), shared by apiRequestContract.logic.test.ts
// (which pins the wire) and fakeServer.logic.test.ts (which checks the fake has a route for each).
import * as api from '../../api';

// The only endpoints whose failure carries the server's reason (`ApiError.serverMessage`).
export const REASON_ENDPOINTS = ['createCategory', 'deleteCategory', 'updateCategory'];

export type Wire = [method: string | null, path: string, timeoutMs: number, body: string | undefined];

// [A1][A2][A3] Every endpoint's request, as the pre-WHIT-631 hand-written fetches sent it.
export const WIRE: Record<string, [() => Promise<unknown>, Wire]> = {
  fetchTransactions: [() => api.fetchTransactions(), [null, '/transactions', 15000, undefined]],
  fetchTransactionsFeed: [() => api.fetchTransactionsFeed('cur', 25), [null, '/transactions/feed?cursor=cur&limit=25', 15000, undefined]],
  fetchUncategorizedFeed: [() => api.fetchUncategorizedFeed('cur', 25), [null, '/transactions/uncategorized/feed?cursor=cur&limit=25', 15000, undefined]],
  fetchTransactionsSearch: [() => api.fetchTransactionsSearch('all', 'steven'), [null, '/transactions/search?tab=all&q=steven', 30000, undefined]],
  fetchUncategorizedCount: [() => api.fetchUncategorizedCount(), [null, '/transactions/uncategorized/count', 15000, undefined]],
  fetchUncategorizedMerchants: [() => api.fetchUncategorizedMerchants(), [null, '/transactions/uncategorized/merchants', 30000, undefined]],
  fetchFilingSuggestions: [() => api.fetchFilingSuggestions(), [null, '/transactions/filing-suggestions', 30000, undefined]],
  applyRulesToUncategorized: [() => api.applyRulesToUncategorized(true), ['POST', '/transactions/uncategorized/apply-rules', 30000, '{"dryRun":true}']],
  startApplyRulesJob: [() => api.startApplyRulesJob(), ['POST', '/transactions/uncategorized/apply-rules/jobs', 15000, '{}']],
  getApplyRulesJob: [() => api.getApplyRulesJob('j1'), [null, '/transactions/uncategorized/apply-rules/jobs/j1', 6000, undefined]],
  startAiChat: [() => api.startAiChat([{ role: 'user', text: 'hi' }]), ['POST', '/ai/chat', 15000, '{"messages":[{"role":"user","text":"hi"}]}']],
  getAiChatJob: [() => api.getAiChatJob('c1'), [null, '/ai/chat/jobs/c1', 6000, undefined]],
  fetchCategories: [() => api.fetchCategories(), [null, '/categories', 15000, undefined]],
  createCategory: [() => api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }), ['POST', '/categories', 15000, '{"name":"Gym","bucket":"Lifestyle","icon":"dumbbell"}']],
  updateCategory: [() => api.updateCategory('gym', { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }), ['PATCH', '/categories/gym', 15000, '{"name":"Gym","bucket":"Lifestyle","icon":"dumbbell"}']],
  deleteCategory: [() => api.deleteCategory('gym'), ['DELETE', '/categories/gym', 15000, undefined]],
  fetchBudgets: [() => api.fetchBudgets(), [null, '/budgets', 15000, undefined]],
  fetchBudgetTransactions: [() => api.fetchBudgetTransactions('groceries'), [null, '/budgets/groceries/transactions', 15000, undefined]],
  fetchBreakdown: [() => api.fetchBreakdown(1), [null, '/breakdown?cycle=1', 15000, undefined]],
  fetchCategoryTransactions: [() => api.fetchCategoryTransactions('groceries', 0), [null, '/categories/groceries/transactions', 15000, undefined]],
  fetchCycleTransactions: [() => api.fetchCycleTransactions(1), [null, '/transactions/cycle?cycle=1', 15000, undefined]],
  setTransactionCategory: [() => api.setTransactionCategory('t1', 'groceries'), ['PATCH', '/transactions/t1', 15000, '{"category":"groceries"}']],
  setTransactionFields: [() => api.setTransactionFields('t1', { notes: 'n' }), ['PATCH', '/transactions/t1', 15000, '{"notes":"n"}']],
  deleteTransaction: [() => api.deleteTransaction('t1'), ['DELETE', '/transactions/t1', 15000, undefined]],
  setTransactionCategories: [() => api.setTransactionCategories([{ id: 't1', category: 'groceries' }]), ['PATCH', '/transactions', 15000, '{"updates":[{"id":"t1","category":"groceries"}]}']],
  fetchHomeLoan: [() => api.fetchHomeLoan(), [null, '/homeloan', 15000, undefined]],
  fetchAccountBalances: [() => api.fetchAccountBalances(), [null, '/accounts/balances', 15000, undefined]],
  refreshAccountBalances: [() => api.refreshAccountBalances(), ['POST', '/accounts/balances/refresh', 30000, undefined]],
  fetchGoals: [() => api.fetchGoals(), [null, '/goals', 15000, undefined]],
  fetchMilestones: [() => api.fetchMilestones(), [null, '/milestones', 15000, undefined]],
  setMilestones: [() => api.setMilestones([]), ['PUT', '/milestones', 15000, '{"milestones":[]}']],
  saveGoal: [() => api.saveGoal('g1', {} as Parameters<typeof api.saveGoal>[1]), ['PUT', '/goals/g1', 15000, '{}']],
  deleteGoal: [() => api.deleteGoal('g1'), ['DELETE', '/goals/g1', 15000, undefined]],
  fetchRepayment: [() => api.fetchRepayment(), [null, '/repayment', 15000, undefined]],
  fetchLoanFacts: [() => api.fetchLoanFacts(), [null, '/loanfacts', 15000, undefined]],
  setLoanFacts: [() => api.setLoanFacts({} as Parameters<typeof api.setLoanFacts>[0]), ['PUT', '/loanfacts', 15000, '{}']],
  fetchPayCycle: [() => api.fetchPayCycle(), [null, '/paycycle', 15000, undefined]],
  setPayCycle: [() => api.setPayCycle({ length: 14, last_pay_date: '2026-07-01' }), ['PUT', '/paycycle', 15000, '{"length":14,"last_pay_date":"2026-07-01"}']],
  setBudget: [() => api.setBudget('groceries', 100), ['PUT', '/budgets/groceries', 15000, '{"target":100}']],
  deleteBudget: [() => api.deleteBudget('groceries'), ['DELETE', '/budgets/groceries', 15000, undefined]],
  setSpread: [() => api.setSpread('groceries', 100, 3), ['PUT', '/budgets/groceries/spread', 15000, '{"amount":100,"cycles":3}']],
  deleteSpread: [() => api.deleteSpread('groceries'), ['DELETE', '/budgets/groceries/spread', 15000, undefined]],
  listRules: [() => api.listRules(), [null, '/rules', 15000, undefined]],
  createRule: [() => api.createRule({ value: 'COLES', categoryId: 'groceries' }), ['POST', '/rules', 15000, '{"value":"COLES","categoryId":"groceries"}']],
  updateRule: [() => api.updateRule('r1', { value: 'COLES', categoryId: 'groceries' }), ['PUT', '/rules/r1', 15000, '{"value":"COLES","categoryId":"groceries"}']],
  deleteRule: [() => api.deleteRule('r1'), ['DELETE', '/rules/r1', 15000, undefined]],
  fetchAiInsights: [() => api.fetchAiInsights(), [null, '/insights/ai', 15000, undefined]],
  generateAiInsights: [() => api.generateAiInsights(null), ['POST', '/insights/ai', 60000, '{"goal":null}']],
  registerDevice: [() => api.registerDevice('ExpoPushToken[abc]'), ['POST', '/devices', 15000, '{"token":"ExpoPushToken[abc]"}']],
};
