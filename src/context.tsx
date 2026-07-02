import React, { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { tint, fmt } from './theme';
import { fetchTransactions, fetchCategories, createCategory, updateCategory, deleteCategory as apiDeleteCategory, fetchBudgets, setBudget as apiSetBudget, setTransactionCategory as apiSetTransactionCategory, BudgetRollup } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Bucket = 'Living' | 'Lifestyle' | 'Income' | 'Savings';

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  bucket: Bucket;
  recent: number;
}
export interface Budget { id: string; budget: number; posted: number; pending: number; }
export interface Transaction {
  transaction_id: string;
  date: string;            // "YYYY-MM-DD"
  authorized_date: string;
  description: string;
  merchant_name: string;
  amount: number;
  account_id: string;
  account_name: string;
  category: string | null;
  status: 'pending' | 'posted';
  type: string;
  counts_to_budget: boolean;
}
export interface Rule { id: string; pattern: string; categoryId: string; isNew: boolean; }
export interface Goal {
  original: number; balance: number; homeValue: number; startYear: string;
  ratePct: number; baseRepay: number; extra: number; freedomDate: string;
  aheadLabel: string; interestSaved: number;
  lastRepay: { amount: number; principal: number; interest: number; date: string };
}
export type Sheet =
  | { mode: 'picker'; txId: string }
  | { mode: 'confirm'; txId: string; categoryId: string }
  | { mode: 'addrule' }
  | { mode: 'paycycle' }
  | null;

export const BUCKETS: Bucket[] = ['Living', 'Lifestyle', 'Income', 'Savings'];
export const BUCKET_COLOR: Record<Bucket, string> = {
  Living: '#7FA9F0', Lifestyle: '#E59BD0', Income: '#35d9a0', Savings: '#C7A8F0',
};
export const PALETTE = ['#E8A87C', '#7FD49B', '#F08C8C', '#8AB4F8', '#F2A0C9', '#C7A8F0', '#F2C94C', '#6FD0C9', '#8FD46B', '#B0A8F0'];

// ---------------------------------------------------------------------------
// Seed data (ported verbatim from Whittle.dc.html)
// ---------------------------------------------------------------------------
const SEED_CATEGORIES: Category[] = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7FD49B', bucket: 'Living', recent: 300 },
  { id: 'eatingout', name: 'Eating Out', icon: 'food', color: '#F08C8C', bucket: 'Lifestyle', recent: 110 },
  { id: 'transport', name: 'Transport', icon: 'car', color: '#8AB4F8', bucket: 'Living', recent: 60 },
  { id: 'health', name: 'Health', icon: 'health', color: '#F2A0C9', bucket: 'Living', recent: 140 },
  { id: 'pets', name: 'Pets', icon: 'pets', color: '#C7A8F0', bucket: 'Lifestyle', recent: 40 },
  { id: 'utilities', name: 'Utilities', icon: 'bolt', color: '#F2C94C', bucket: 'Living', recent: 230 },
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#6FD0C9', bucket: 'Lifestyle', recent: 95 },
  { id: 'fitness', name: 'Health & Fitness', icon: 'dumbbell', color: '#8FD46B', bucket: 'Lifestyle', recent: 64 },
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#F0B27A', bucket: 'Lifestyle', recent: 46 },
  { id: 'travel', name: 'Travel', icon: 'plane', color: '#6FB6D0', bucket: 'Lifestyle', recent: 0 },
  { id: 'gifts', name: 'Gifts', icon: 'gift', color: '#E59BD0', bucket: 'Lifestyle', recent: 28 },
  { id: 'phonenet', name: 'Phone & Internet', icon: 'phone', color: '#B0A8F0', bucket: 'Living', recent: 79 },
];
const SEED_RULES: Rule[] = [
  { id: 'r1', pattern: 'WOOLWORTHS', categoryId: 'groceries', isNew: false },
  { id: 'r2', pattern: 'AGL', categoryId: 'utilities', isNew: false },
  { id: 'r3', pattern: 'SHELL', categoryId: 'transport', isNew: false },
  { id: 'r4', pattern: 'CAFE BONES', categoryId: 'coffee', isNew: false },
];
const SEED_GOAL: Goal = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

export const CLEAN_NAME: Record<string, string> = {
  'DD *DOORDASH HUTIEUGOO': 'DoorDash',
  'UNIFLEX REMEDIAL MASSAGE': 'Uniflex Massage',
  'SQ *KKV INTERNATIONAL': 'KKV International',
};
export function cleanName(m: string) { return CLEAN_NAME[m] || m; }

// Best-effort display name for a transaction's merchant, applying the cleanup
// map. Single source of truth so the transaction row and the categorize sheets
// never diverge (the Transaction shape has merchant_name/description, not payee).
export function merchantLabel(t: Transaction): string {
  return cleanName(t.merchant_name || t.description);
}

function dateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(y, m - 1, d);
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${DAY[date.getDay()]} ${d} ${MON[m - 1]}`;
}

const REPAY_LINES = [
  '−$1,440 just hit the mortgage. $1,208 of it murdered actual principal. The beast shrinks. 🪓',
  "Repayment landed: $1,440. That's another brick out of the wall. Future-you is doing a little dance. 💃",
  'Boom — $1,208 off the principal. The death-pledge dies a little more today. ⚰️',
];

// ---------------------------------------------------------------------------
// AppContext
// ---------------------------------------------------------------------------
interface AppContext {
  // data
  categories: Category[]; budgets: Budget[]; transactions: Transaction[]; rules: Rule[]; goal: Goal;
  payCycle: { length: number; anchor: string }; alerts: boolean;
  daysLeft: number; cycleLen: number;
  // ephemeral ui
  sheet: Sheet; toast: string | null; notif: { body: string; time: string } | null;
  // helpers
  category: (id: string | null) => Category | undefined;
  cycleName: () => string;
  // actions
  setSheet: (s: Sheet) => void;
  showToast: (m: string) => void;
  dismissNotif: () => void;
  toggleAlerts: () => void;
  setPayCycleLength: (len: number) => void;
  openPicker: (txId: string) => void;
  chooseCategory: (categoryId: string) => void;
  applyCategory: (scope: 'one' | 'all') => Promise<void>;
  saveBudget: (categoryId: string, value: number) => Promise<boolean>;
  saveCategory: (editId: string | null, form: { name: string; bucket: Bucket; icon: string }) => Promise<boolean>;
  deleteCategory: (id: string) => Promise<boolean>;
  deleteRule: (id: string) => void;
  saveManualRule: (pattern: string, categoryId: string) => void;
  fireRepayment: () => void;
	
	transactionsLoading: boolean;
	refreshTransactions: () => Promise<void>;
	categoriesLoading: boolean;
	refreshCategories: () => Promise<void>;
	budgetsLoading: boolean;
	refreshBudgets: () => Promise<void>;
}

/**
 * Map a raw category object from the categories API into the client-side
 * `Category` shape, defaulting any missing field so downstream budget math never
 * sees `undefined`/`NaN`. The server always returns `recent: 0`, and `icon`
 * falls back to a key that is guaranteed to exist in the icon map (`coffee`)
 * rather than the server's own default, so the chip always renders a glyph.
 *
 * @param raw - A single category record as returned by the categories API.
 * @returns A fully-populated `Category` safe to store and render.
 */
function toCategory(raw: any): Category {
  return {
    id: raw.id,
    name: raw.name,
    bucket: raw.bucket,
    icon: raw.icon ?? 'coffee',
    color: raw.color ?? PALETTE[0],
    recent: typeof raw.recent === 'number' ? raw.recent : 0,
  };
}

// Merge a server budget target into the client Budget shape. The /budgets
// The server rollup owns the target AND the computed posted/pending spend for
// the window, so we take all three straight from it. Module-level (like
// toCategory) so refreshBudgets stays a stable callback.
function toBudget(id: string, rollup: BudgetRollup): Budget {
  return { id, budget: rollup.target, posted: rollup.posted, pending: rollup.pending };
}

const Ctx = createContext<AppContext | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [categories, setCategories] = useState<Category[]>(SEED_CATEGORIES);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [rules, setRules] = useState<Rule[]>(SEED_RULES);
  const [goal, setGoal] = useState<Goal>(SEED_GOAL);
  const [payCycle, setPayCycle] = useState({ length: 14, anchor: 'Wednesday' });
  const [alerts, setAlerts] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notif, setNotif] = useState<{ body: string; time: string } | null>(null);

	const [transactionsLoading, setTransactionsLoading] = useState(false);
	const refreshTransactions = useCallback(async () => {
		setTransactionsLoading(true);
		try {
			const data = await fetchTransactions();
			setTransactions(data);
		} finally{
			setTransactionsLoading(false);
		}
	}, []);

	const [categoriesLoading, setCategoriesLoading] = useState(false);
	const refreshCategories = useCallback(async () => {
		setCategoriesLoading(true);
		try {
			const data = await fetchCategories();
			setCategories(data.map(toCategory));
		} finally {
			setCategoriesLoading(false);
		}
	}, []);

	const [budgetsLoading, setBudgetsLoading] = useState(false);
	const refreshBudgets = useCallback(async () => {
		setBudgetsLoading(true);
		try {
			// Window length = the user's pay-cycle length, so the server sums spend
			// over the matching period.
			const map = await fetchBudgets(payCycle.length);
			// Server owns which categories are budgeted and their spent/pending, so
			// replace the array. Skip target<=0 rows so budget math never divides by zero.
			setBudgets(
				Object.entries(map)
					.filter(([, rollup]) => rollup.target > 0)
					.map(([id, rollup]) => toBudget(id, rollup)));
		} finally {
			setBudgetsLoading(false);
		}
	}, [payCycle.length]);

	useEffect(() => {
		refreshTransactions();
		refreshCategories();
	}, [refreshTransactions, refreshCategories]);

	// Re-fetch budgets on mount and whenever the pay-cycle length (the window) changes.
	useEffect(() => {
		refreshBudgets();
	}, [refreshBudgets]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notifTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repayIdx = useRef(0);

  const category = useCallback((id: string | null) => categories.find((c) => c.id === id), [categories]);
  const cycleName = useCallback(
    () => (payCycle.length === 7 ? 'Weekly' : payCycle.length === 14 ? 'Fortnightly' : 'Monthly'),
    [payCycle.length],
  );

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  const dismissNotif = useCallback(() => { clearTimeout(notifTimer.current); setNotif(null); }, []);

  const openPicker = useCallback((txId: string) => setSheet({ mode: 'picker', txId }), []);
  const chooseCategory = useCallback(
    (categoryId: string) => setSheet((s) => (s && s.mode === 'picker' ? { mode: 'confirm', txId: s.txId, categoryId } : s)),
    [],
  );

  const applyCategory = useCallback(async (scope: 'one' | 'all'): Promise<void> => {
    // This is only ever triggered from the confirm sheet; ignore any other state.
    if (!sheet || sheet.mode !== 'confirm') return;
    const { txId, categoryId } = sheet;
    const transaction = transactions.find((t) => t.transaction_id === txId);
    const category = categories.find((c) => c.id === categoryId);
    if (!transaction || !category) {
      setSheet(null); // nothing to categorise — just close the sheet
      return;
    }

    if (scope === 'all') {
      // "Every {merchant} charge": every OTHER uncategorised transaction from the
      // same merchant (matched by description) that counts toward a budget. Captured
      // once so the optimistic update and the failure-revert act on the same set.
      const sameMerchantIds = transactions
        .filter((t) =>
          t.counts_to_budget &&
          t.category == null &&
          t.description === transaction.description)
        .map((t) => t.transaction_id);

      // Optimistically file all of them under the chosen category (one state update).
      setTransactions((prev) =>
        prev.map((existing) => {
          if (!sameMerchantIds.includes(existing.transaction_id)) return existing;
          return { ...existing, category: categoryId };
        }));

      // Remember the intent as a local rule so the UI reflects it. Durable,
      // server-side rules are a separate slice (WHIT-52).
      setRules((prev) => {
        const newRule: Rule = {
          id: 'r' + Date.now(),          // unique-enough local id
          pattern: transaction.description, // match future charges by this text
          categoryId,                     // file them under the chosen category
          isNew: true,                    // flags the "NEW" badge in the rules list
        };
        // Prepend so the newest rule shows at the top of the list.
        return [newRule, ...prev];
      });
      showToast(`Rule saved — future ${cleanName(transaction.description)} charges file as ${category.name}.`);
      setSheet(null); // close the confirm sheet

      // Persist each transaction to the server, all in parallel.
      const outcomes = await Promise.allSettled(
        sameMerchantIds.map((id) => apiSetTransactionCategory(id, categoryId)));

      // Promise.allSettled keeps the input order, so outcomes[index] is the result
      // for sameMerchantIds[index]. Keep the ids whose save was rejected.
      const failedIds = sameMerchantIds.filter((id, index) => {
        return outcomes[index].status === 'rejected';
      });
      if (failedIds.length > 0) {
        // Roll back only the ones whose save failed (back to uncategorised).
        setTransactions((prev) =>
          prev.map((existing) => {
            if (!failedIds.includes(existing.transaction_id)) return existing;
            return { ...existing, category: null };
          }));
        showToast('Could not save some categories. Please try again.');
      }
      // Some categorisations persisted -> refresh the bars so budget spend updates.
      if (failedIds.length < sameMerchantIds.length) refreshBudgets();
      return;
    }

    // scope === 'one': just this single transaction.
    const previousCategory = transaction.category;
    // Optimistically show the new category on this one transaction.
    setTransactions((prev) =>
      prev.map((existing) => {
        if (existing.transaction_id !== txId) return existing;
        return { ...existing, category: categoryId };
      }));
    showToast(`This transaction filed under ${category.name}.`);
    setSheet(null); // close the confirm sheet

    try {
      await apiSetTransactionCategory(txId, categoryId);
      refreshBudgets(); // reflect the new categorisation in the budget bars
    } catch {
      // Save failed — undo the optimistic change, putting the old category back.
      setTransactions((prev) =>
        prev.map((existing) => {
          if (existing.transaction_id !== txId) return existing;
          return { ...existing, category: previousCategory };
        }));
      showToast('Could not save category. Please try again.');
    }
  }, [sheet, transactions, categories, showToast, refreshBudgets]);

  const saveBudget = useCallback(
    async (categoryId: string, value: number): Promise<boolean> => {
      if (value <= 0) return false;
      const c = categories.find((x) => x.id === categoryId);
      const existing = budgets.find((b) => b.id === categoryId);
      try {
        const saved = await apiSetBudget(categoryId, value);
        // Optimistically show the new target right away (keyed off the known
        // categoryId). A brand-new budget starts at 0 spend locally...
        setBudgets((prev) =>
          prev.some((b) => b.id === categoryId)
            ? prev.map((b) => (b.id === categoryId ? { ...b, budget: saved.target } : b))
            : [...prev, { id: categoryId, budget: saved.target, posted: 0, pending: 0 }]);
        // ...then pull the server rollup so its real posted/pending fill in.
        refreshBudgets();
        if (c) showToast(`${c.name} budget ${existing ? 'updated' : 'set'} to ${fmt(saved.target)}.`);
        return true;
      } catch {
        showToast('Could not save budget. Please try again.');
        return false;
      }
    },
    [categories, budgets, showToast, refreshBudgets],
  );

  const saveCategory = useCallback(
    async (editId: string | null, form: { name: string; bucket: Bucket; icon: string }): Promise<boolean> => {
      const name = form.name.trim();
      if (!name) return false;
      try {
        if (editId) {
          const updated = await updateCategory(editId, { name, bucket: form.bucket, icon: form.icon });
          setCategories((prev) => prev.map((c) => (c.id === editId ? toCategory(updated) : c)));
          showToast('Category updated.');
        } else {
          const created = await createCategory({ name, bucket: form.bucket, icon: form.icon });
          setCategories((prev) => [...prev, toCategory(created)]);
          showToast('Category created.');
        }
        return true;
      } catch {
        showToast('Could not save category. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  const deleteCategory = useCallback(async (id: string): Promise<boolean> => {
    try {
      await apiDeleteCategory(id);
      // Local cascade: drop the category's budget/rules and clear it off any
      // referencing transaction (cosmetic — the server does no cascade, so on the
      // next refresh those txns re-appear with the dangling id and render as
      // Uncategorized via isUncategorized).
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setBudgets((prev) => prev.filter((b) => b.id !== id));
      setRules((prev) => prev.filter((r) => r.categoryId !== id));
      setTransactions((prev) => prev.map((t) => (t.category === id ? { ...t, category: null } : t)));
      showToast('Category deleted.');
      return true;
    } catch {
      showToast('Could not delete category. Please try again.');
      return false;
    }
  }, [showToast]);

  const deleteRule = useCallback((id: string) => setRules((prev) => prev.filter((r) => r.id !== id)), []);

  const saveManualRule = useCallback((pattern: string, categoryId: string) => {
    const p = pattern.trim().toUpperCase();
    if (!p || !categoryId) return;
    const c = categories.find((x) => x.id === categoryId);
    setRules((prev) => [{ id: 'r' + Date.now(), pattern: p, categoryId, isNew: true }, ...prev]);
    setSheet(null);
    if (c) showToast(`Rule added — ${p} files as ${c.name}.`);
  }, [categories, showToast]);

  const fireRepayment = useCallback(() => {
    const principal = 1208;
    const body = REPAY_LINES[(repayIdx.current = (repayIdx.current + 1) % REPAY_LINES.length)];
    setGoal((g) => ({ ...g, balance: Math.max(0, g.balance - principal), lastRepay: { ...g.lastRepay, date: 'Just now' } }));
    setNotif({ body, time: 'now' });
    clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotif(null), 5600);
  }, []);

  const value = useMemo<AppContext>(() => ({
    categories, budgets, transactions, rules, goal, payCycle, alerts, daysLeft: 7, cycleLen: 14,
    sheet, toast, notif,
    category, cycleName,
    setSheet, showToast, dismissNotif,
    toggleAlerts: () => setAlerts((a) => !a),
    setPayCycleLength: (len) => setPayCycle((p) => ({ ...p, length: len })),
    openPicker, chooseCategory, applyCategory, saveBudget, saveCategory, deleteCategory, deleteRule, saveManualRule, fireRepayment, transactionsLoading, refreshTransactions, categoriesLoading, refreshCategories, budgetsLoading, refreshBudgets
  }), [categories, budgets, transactions, rules, goal, payCycle, alerts, sheet, toast, notif, category, cycleName, showToast, dismissNotif, openPicker, chooseCategory, applyCategory, saveBudget, saveCategory, deleteCategory, deleteRule, saveManualRule, fireRepayment, transactionsLoading, refreshTransactions, categoriesLoading, refreshCategories, budgetsLoading, refreshBudgets]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppContext(): AppContext {
  const s = useContext(Ctx);
  if (!s) throw new Error('useAppContext must be used within AppProvider');
  return s;
}

// ---------------------------------------------------------------------------
// Derived-value selectors (ported from renderVals). Pure functions over state.
// ---------------------------------------------------------------------------
export function elapsedFrac(s: AppContext) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }

export interface BudgetView {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spentLabel: string; remainAmount: string; remainLabel: string; remainColor: string;
  postedPct: number; pendingPct: number; targetPct: number; postedColor: string;
  pendingTint: string; paceLabel: string; paceColor: string; over: boolean;
}

export function budgetViews(s: AppContext): { rows: BudgetView[]; totBudget: number; totSpent: number; totRemain: number } {
  const elapsed = elapsedFrac(s);
  let totBudget = 0, totSpent = 0, totRemain = 0;
  const rows: BudgetView[] = [];
  for (const b of s.budgets) {
    const c = s.category(b.id);
    if (!c) continue;
    // posted/pending come from the server rollup (computed over the window).
    const pending = b.pending, posted = b.posted, spent = posted + pending, remain = b.budget - spent;
    totBudget += b.budget; totSpent += spent; totRemain += remain;
    const over = spent > b.budget;
    const postedPct = Math.max(0, Math.min(100, (posted / b.budget) * 100));
    const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
    const target = b.budget * elapsed;
    let paceLabel: string, paceColor: string;
    if (over) { paceLabel = fmt(spent - b.budget) + ' over budget'; paceColor = '#ff6b6b'; }
    else if (spent - target > 0.5) { paceLabel = fmt(spent - target) + ' over pace'; paceColor = '#f4b740'; }
    else if (target - spent > 0.5) { paceLabel = fmt(target - spent) + ' under pace'; paceColor = '#35d9a0'; }
    else { paceLabel = 'on pace'; paceColor = '#35d9a0'; }
    const spentLabel = pending > 0
      ? `${fmt(spent)} spent (${fmt(pending)} pending) of ${fmt(b.budget)}`
      : `${fmt(spent)} spent of ${fmt(b.budget)}`;
    rows.push({
      id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
      spentLabel, remainAmount: fmt(remain), remainLabel: over ? 'over' : 'left', remainColor: over ? '#ff6b6b' : '#cfd2ff',
      postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: over ? '#ff6b6b' : c.color,
      pendingTint: tint(over ? '#ff6b6b' : c.color, 0.45), paceLabel, paceColor, over,
    });
  }
  return { rows, totBudget, totSpent, totRemain };
}

export interface TransactionView {
  id: string; merchant: string; amountLabel: string; amountColor: string;
  isPending: boolean; icon: string; iconColor: string; chipBg: string;
  categoryLabel: string; categoryColor: string; categoryWeight: '500' | '700'; tappable: boolean;
}

// A transaction is uncategorized when it has no resolvable Whittle category: its
// category is null, or it points at an id not in the taxonomy (e.g. a raw BankSync
// category not yet mapped). 'income' is a category, not uncategorized. Single
// source of truth so the row label, the tab list, and the badge always agree.
export function isUncategorized(s: AppContext, t: Transaction): boolean {
  return t.category !== 'income' && (t.category == null || !s.category(t.category));
}

export function transactionView(s: AppContext, t: Transaction): TransactionView {
  const c = t.category == null || t.category === 'income' ? undefined : s.category(t.category);
  const uncategorized = isUncategorized(s, t);
  const isIncome = t.category === 'income';
  const key = uncategorized ? 'q' : isIncome ? 'home' : c!.icon;
  const amtStr = (t.amount < 0 ? '-' : '+') + '$' + Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: t.transaction_id, merchant: merchantLabel(t), amountLabel: amtStr, amountColor: t.amount > 0 ? '#35d9a0' : '#f1f1f4',
    isPending: t.status === 'pending', icon: key,
    iconColor: uncategorized ? '#c9b3f5' : isIncome ? '#9aa2b5' : c!.color,
    chipBg: uncategorized ? 'rgba(160,130,240,.16)' : isIncome ? 'rgba(154,162,181,.14)' : tint(c!.color, 0.15),
    categoryLabel: uncategorized ? 'Uncategorized' : isIncome ? 'Income' : c!.name,
    categoryColor: uncategorized ? '#c9b3f5' : isIncome ? '#9aa2b5' : '#9a9aa4',
    categoryWeight: uncategorized ? '700' : '500', tappable: uncategorized,
  };
}

export function transactionGroups(s: AppContext, tab: 'all' | 'uncategorized') {
  const tabFilter = (t: Transaction) => (tab === 'uncategorized' ? t.counts_to_budget && isUncategorized(s, t) : true);
  const seen = new Map<string, Transaction[]>();
  const order: string[] = [];
  for (const t of s.transactions.filter(tabFilter)) {
    const label = dateLabel(t.date);
    if (!seen.has(label)) { seen.set(label, []); order.push(label); }
    seen.get(label)!.push(t);
  }
  return order.map((label) => ({ label, items: seen.get(label)! }));
}

export function countUncategorized(s: AppContext) {
  return s.transactions.filter((t) => t.counts_to_budget && isUncategorized(s, t)).length;
}

export function budgetDetail(s: AppContext, categoryId: string) {
  const c = s.category(categoryId);
  const b = s.budgets.find((x) => x.id === categoryId);
  if (!c || !b) return null;
  const elapsed = elapsedFrac(s);
  // posted/pending come from the server rollup (computed over the window).
  const pending = b.pending, posted = b.posted, spent = posted + pending;
  const over = spent > b.budget;
  const postedPct = Math.max(0, Math.min(100, (posted / b.budget) * 100));
  const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
  const remain = b.budget - spent;
  const daily = remain > 0 ? remain / Math.max(1, s.daysLeft) : 0;
  const relSeen = new Map<string, Transaction[]>();
  const relOrder: string[] = [];
  for (const t of s.transactions.filter((t) => t.category === b.id)) {
    const label = dateLabel(t.date);
    if (!relSeen.has(label)) { relSeen.set(label, []); relOrder.push(label); }
    relSeen.get(label)!.push(t);
  }
  const relGroups = relOrder.map((label) => ({ label, items: relSeen.get(label)! }));
  return {
    name: c.name, icon: c.icon, color: c.color,
    spentBig: fmt(spent), ofBudget: 'of ' + fmt(b.budget),
    statusLabel: over ? 'Over budget — ease up' : 'On target — keep it up',
    statusColor: over ? '#ff6b6b' : '#35d9a0',
    daysLeftLabel: `${s.daysLeft} days remaining`,
    postedPct, pendingPct, targetPct: Math.round(elapsed * 100),
    postedColor: over ? '#ff6b6b' : c.color, pendingTint: tint(over ? '#ff6b6b' : c.color, 0.45),
    dailyLabel: over ? 'Daily limit: $0' : `Daily limit: ${fmt(daily)}`,
    relGroups, relEmpty: relGroups.length === 0,
  };
}

export function budgetEditInfo(s: AppContext, categoryId: string) {
  const c = s.category(categoryId);
  const existing = s.budgets.find((b) => b.id === categoryId);
  const avg = c ? Math.round(c.recent) : 0;
  const last = Math.round(avg * 0.92);
  const rec = avg; // recommendBasis default: Recent average
  const cn = s.cycleName();
  const histVals = [0.7, 0.5, 0.9, 0.6, 1.0, 0.8];
  const histLabels = ['F1', 'F2', 'F3', 'F4', 'F5', 'Now'];
  const histBars = histVals.map((v, i) => ({ h: Math.round(14 + v * 76), label: histLabels[i], last: i === 5 }));
  return {
    category: c, existing, avg, last, rec,
    recLabel: fmt(rec), lastLabel: fmt(last), avgLabel: fmt(avg),
    periodLabel: cn.toUpperCase(),
    lastWord: cn === 'Weekly' ? 'week' : cn === 'Monthly' ? 'month' : 'fortnight',
    recommendCta: 'Use my average spend',
    histBars,
    title: existing ? 'Edit budget' : 'Set budget',
    saveText: existing ? 'Update budget' : 'Add budget',
  };
}

export function goalView(s: AppContext) {
  const G = s.goal;
  const paidOff = G.original - G.balance;
  const paidPct = Math.max(0, Math.min(100, (paidOff / G.original) * 100));
  const chunk = 50000;
  const totalChunks = Math.round(G.original / chunk);
  const chunksCleared = Math.floor(paidOff / chunk);
  const nextMs = Math.floor((G.balance - 1) / chunk) * chunk;
  const toNextMs = G.balance - nextMs;
  const usableEquity = Math.max(0, Math.round(G.homeValue * 0.8 - G.balance));
  const depositTarget = 90000;
  const depositPct = Math.max(0, Math.min(100, (usableEquity / depositTarget) * 100));
  const contribution = G.baseRepay + G.extra;
  return { G, paidOff, paidPct, chunk, totalChunks, chunksCleared, nextMs, toNextMs, usableEquity, depositTarget, depositPct, contribution };
}
