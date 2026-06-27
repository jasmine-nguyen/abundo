import React, { createContext, useContext, useMemo, useRef, useState, useCallback } from 'react';
import { tint, fmt } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Bucket = 'Living' | 'Lifestyle' | 'Income' | 'Savings';

export interface Cat {
  id: string;
  name: string;
  icon: string;
  color: string;
  bucket: Bucket;
  recent: number;
}
export interface Budget { id: string; budget: number; posted: number; pending: number; }
export interface Txn {
  transaction_id: string;
  payee: string;
  amount: number;
  status: 'pending' | 'posted';
  date: string;            // "YYYY-MM-DD"
  category: string | null;
  ps_category: string | null;
  source: string;
  account_name: string;
  counts_to_budget: boolean;
}
export interface Rule { id: string; pattern: string; catId: string; isNew: boolean; }
export interface Goal {
  original: number; balance: number; homeValue: number; startYear: string;
  ratePct: number; baseRepay: number; extra: number; freedomDate: string;
  aheadLabel: string; interestSaved: number;
  lastRepay: { amount: number; principal: number; interest: number; date: string };
}
export type Sheet =
  | { mode: 'picker'; txId: string }
  | { mode: 'confirm'; txId: string; catId: string }
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
const SEED_CATS: Cat[] = [
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
const SEED_BUDGETS: Budget[] = [
  { id: 'coffee', budget: 58, posted: 27, pending: 12 },
  { id: 'eatingout', budget: 120, posted: 70, pending: 14 },
  { id: 'groceries', budget: 320, posted: 120, pending: 19 },
  { id: 'health', budget: 191, posted: 95, pending: 0 },
  { id: 'transport', budget: 56, posted: 6, pending: 0 },
  { id: 'utilities', budget: 240, posted: 0, pending: 188 },
  { id: 'pets', budget: 49, posted: 0, pending: 0 },
  { id: 'shopping', budget: 100, posted: 30, pending: 0 },
];
const SEED_TXNS: Txn[] = [
  { id: 't1', merchant: 'DD *DOORDASH HUTIEUGOO', match: 'DOORDASH', amount: -46.33, day: 'Today', date: 'Today', status: 'pending', catId: null, countsToBudget: true },
  { id: 't2', merchant: 'UNIFLEX REMEDIAL MASSAGE', match: 'UNIFLEX', amount: -120.0, day: 'Today', date: 'Today', status: 'pending', catId: null, countsToBudget: true },
  { id: 't3', merchant: 'SQ *KKV INTERNATIONAL', match: 'KKV', amount: -5.5, day: 'Today', date: 'Today', status: 'pending', catId: null, countsToBudget: true },
  { id: 't4', merchant: 'Woolworths Metro', match: 'WOOLWORTHS', amount: -38.2, day: 'Today', date: 'Today', status: 'posted', catId: 'groceries', countsToBudget: false },
  { id: 't5', merchant: 'AGL Energy', match: 'AGL', amount: -187.71, day: 'Today', date: 'Today', status: 'pending', catId: 'utilities', countsToBudget: false },
  { id: 't6', merchant: 'Salary — Northwind Pty', match: 'NORTHWIND', amount: 2450.0, day: 'Yesterday', date: 'Yesterday', status: 'posted', catId: 'income', countsToBudget: false },
  { id: 't7', merchant: 'Shell Coles Express', match: 'SHELL', amount: -52.1, day: 'Yesterday', date: 'Yesterday', status: 'posted', catId: 'transport', countsToBudget: false },
  { id: 't8', merchant: 'Cafe Bones', match: 'CAFE BONES', amount: -6.5, day: 'Yesterday', date: 'Yesterday', status: 'posted', catId: 'coffee', countsToBudget: false },
  { id: 't9', merchant: 'Chemist Warehouse', match: 'CHEMIST', amount: -24.9, day: 'Yesterday', date: 'Yesterday', status: 'posted', catId: 'health', countsToBudget: false },
  { id: 't10', merchant: 'SQ *KKV INTERNATIONAL', match: 'KKV', amount: -5.5, day: 'Earlier', date: 'Mon 22 Jun', status: 'posted', catId: 'coffee', countsToBudget: false },
  { id: 't11', merchant: 'Industry Beans', match: 'INDUSTRY', amount: -5.2, day: 'Earlier', date: 'Mon 22 Jun', status: 'posted', catId: 'coffee', countsToBudget: false },
  { id: 't12', merchant: 'Aldi Seddon', match: 'ALDI', amount: -64.3, day: 'Earlier', date: 'Mon 22 Jun', status: 'posted', catId: 'groceries', countsToBudget: false },
  { id: 't13', merchant: 'Myki Top Up', match: 'MYKI', amount: -20.0, day: 'Earlier', date: 'Mon 22 Jun', status: 'posted', catId: 'transport', countsToBudget: false },
  { id: 't14', merchant: "ZLR*SEDDON's Eatery", match: 'SEDDON', amount: -14.49, day: 'Earlier', date: 'Sun 21 Jun', status: 'posted', catId: 'eatingout', countsToBudget: false },
  { id: 't15', merchant: 'Padre Coffee', match: 'PADRE', amount: -8.5, day: 'Earlier', date: 'Sun 21 Jun', status: 'posted', catId: 'coffee', countsToBudget: false },
  { id: 't16', merchant: 'Chemist Warehouse', match: 'CHEMIST', amount: -18.0, day: 'Earlier', date: 'Sun 21 Jun', status: 'posted', catId: 'health', countsToBudget: false },
];
const SEED_RULES: Rule[] = [
  { id: 'r1', pattern: 'WOOLWORTHS', catId: 'groceries', isNew: false },
  { id: 'r2', pattern: 'AGL', catId: 'utilities', isNew: false },
  { id: 'r3', pattern: 'SHELL', catId: 'transport', isNew: false },
  { id: 'r4', pattern: 'CAFE BONES', catId: 'coffee', isNew: false },
];
const SEED_GOAL: Goal = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

export const DATE_ORDER = ['Today', 'Yesterday', 'Mon 22 Jun', 'Sun 21 Jun'];

export const CLEAN_NAME: Record<string, string> = {
  'DD *DOORDASH HUTIEUGOO': 'DoorDash',
  'UNIFLEX REMEDIAL MASSAGE': 'Uniflex Massage',
  'SQ *KKV INTERNATIONAL': 'KKV International',
};
export function cleanName(m: string) { return CLEAN_NAME[m] || m; }

const REPAY_LINES = [
  '−$1,440 just hit the mortgage. $1,208 of it murdered actual principal. The beast shrinks. 🪓',
  "Repayment landed: $1,440. That's another brick out of the wall. Future-you is doing a little dance. 💃",
  'Boom — $1,208 off the principal. The death-pledge dies a little more today. ⚰️',
];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface Store {
  // data
  cats: Cat[]; budgets: Budget[]; txns: Txn[]; rules: Rule[]; goal: Goal;
  payCycle: { length: number; anchor: string }; alerts: boolean;
  daysLeft: number; cycleLen: number;
  // ephemeral ui
  sheet: Sheet; toast: string | null; notif: { body: string; time: string } | null;
  // helpers
  cat: (id: string | null) => Cat | undefined;
  extraFor: (catId: string) => number;
  cycleName: () => string;
  // actions
  setSheet: (s: Sheet) => void;
  showToast: (m: string) => void;
  dismissNotif: () => void;
  toggleAlerts: () => void;
  setPayCycleLength: (len: number) => void;
  openPicker: (txId: string) => void;
  chooseCat: (catId: string) => void;
  applyCat: (scope: 'one' | 'all') => void;
  saveBudget: (catId: string, value: number) => void;
  saveCat: (editId: string | null, form: { name: string; bucket: Bucket; icon: string }) => void;
  deleteCat: (id: string) => void;
  deleteRule: (id: string) => void;
  saveManualRule: (pattern: string, catId: string) => void;
  fireRepayment: () => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [cats, setCats] = useState<Cat[]>(SEED_CATS);
  const [budgets, setBudgets] = useState<Budget[]>(SEED_BUDGETS);
  const [txns, setTxns] = useState<Txn[]>(SEED_TXNS);
  const [rules, setRules] = useState<Rule[]>(SEED_RULES);
  const [goal, setGoal] = useState<Goal>(SEED_GOAL);
  const [payCycle, setPayCycle] = useState({ length: 14, anchor: 'Wednesday' });
  const [alerts, setAlerts] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notif, setNotif] = useState<{ body: string; time: string } | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notifTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repayIdx = useRef(0);

  const cat = useCallback((id: string | null) => cats.find((c) => c.id === id), [cats]);
  const extraFor = useCallback(
    (catId: string) => txns.filter((t) => t.countsToBudget && t.catId === catId).reduce((s, t) => s + Math.abs(t.amount), 0),
    [txns],
  );
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
  const chooseCat = useCallback(
    (catId: string) => setSheet((s) => (s && s.mode === 'picker' ? { mode: 'confirm', txId: s.txId, catId } : s)),
    [],
  );

  const applyCat = useCallback((scope: 'one' | 'all') => {
    setSheet((s) => {
      if (!s || s.mode !== 'confirm') return s;
      const tx = txns.find((t) => t.id === s.txId);
      const c = cats.find((x) => x.id === s.catId);
      if (!tx || !c) return null;
      if (scope === 'all') {
        setTxns((prev) => prev.map((t) => (t.countsToBudget && t.catId === null && t.match === tx.match ? { ...t, catId: s.catId } : t)));
        setRules((prev) => [{ id: 'r' + Date.now(), pattern: tx.match, catId: s.catId, isNew: true }, ...prev]);
        showToast(`Rule saved — future ${cleanName(tx.merchant)} charges file as ${c.name}.`);
      } else {
        setTxns((prev) => prev.map((t) => (t.id === s.txId ? { ...t, catId: s.catId } : t)));
        showToast(`This transaction filed under ${c.name}.`);
      }
      return null;
    });
  }, [txns, cats, showToast]);

  const saveBudget = useCallback((catId: string, value: number) => {
    if (value <= 0) return;
    const c = cats.find((x) => x.id === catId);
    const existing = budgets.find((b) => b.id === catId);
    setBudgets((prev) => (existing ? prev.map((b) => (b.id === catId ? { ...b, budget: value } : b)) : [...prev, { id: catId, budget: value, posted: 0, pending: 0 }]));
    if (c) showToast(`${c.name} budget ${existing ? 'updated' : 'set'} to ${fmt(value)}.`);
  }, [cats, budgets, showToast]);

  const saveCat = useCallback((editId: string | null, form: { name: string; bucket: Bucket; icon: string }) => {
    if (!form.name.trim()) return;
    if (editId) {
      setCats((prev) => prev.map((c) => (c.id === editId ? { ...c, name: form.name.trim(), bucket: form.bucket, icon: form.icon } : c)));
    } else {
      setCats((prev) => [...prev, { id: 'c' + Date.now(), name: form.name.trim(), bucket: form.bucket, icon: form.icon, color: PALETTE[prev.length % PALETTE.length], recent: 0 }]);
    }
    showToast(`Category ${editId ? 'updated' : 'created'}.`);
  }, [showToast]);

  const deleteCat = useCallback((id: string) => {
    setCats((prev) => prev.filter((c) => c.id !== id));
    setBudgets((prev) => prev.filter((b) => b.id !== id));
    setRules((prev) => prev.filter((r) => r.catId !== id));
    setTxns((prev) => prev.map((t) => (t.catId === id ? { ...t, catId: null } : t)));
    showToast('Category deleted.');
  }, [showToast]);

  const deleteRule = useCallback((id: string) => setRules((prev) => prev.filter((r) => r.id !== id)), []);

  const saveManualRule = useCallback((pattern: string, catId: string) => {
    const p = pattern.trim().toUpperCase();
    if (!p || !catId) return;
    const c = cats.find((x) => x.id === catId);
    setRules((prev) => [{ id: 'r' + Date.now(), pattern: p, catId, isNew: true }, ...prev]);
    setSheet(null);
    if (c) showToast(`Rule added — ${p} files as ${c.name}.`);
  }, [cats, showToast]);

  const fireRepayment = useCallback(() => {
    const principal = 1208;
    const body = REPAY_LINES[(repayIdx.current = (repayIdx.current + 1) % REPAY_LINES.length)];
    setGoal((g) => ({ ...g, balance: Math.max(0, g.balance - principal), lastRepay: { ...g.lastRepay, date: 'Just now' } }));
    setNotif({ body, time: 'now' });
    clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotif(null), 5600);
  }, []);

  const value = useMemo<Store>(() => ({
    cats, budgets, txns, rules, goal, payCycle, alerts, daysLeft: 7, cycleLen: 14,
    sheet, toast, notif,
    cat, extraFor, cycleName,
    setSheet, showToast, dismissNotif,
    toggleAlerts: () => setAlerts((a) => !a),
    setPayCycleLength: (len) => setPayCycle((p) => ({ ...p, length: len })),
    openPicker, chooseCat, applyCat, saveBudget, saveCat, deleteCat, deleteRule, saveManualRule, fireRepayment,
  }), [cats, budgets, txns, rules, goal, payCycle, alerts, sheet, toast, notif, cat, extraFor, cycleName, showToast, dismissNotif, openPicker, chooseCat, applyCat, saveBudget, saveCat, deleteCat, deleteRule, saveManualRule, fireRepayment]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used within StoreProvider');
  return s;
}

// ---------------------------------------------------------------------------
// Derived-value selectors (ported from renderVals). Pure functions over state.
// ---------------------------------------------------------------------------
export function elapsedFrac(s: Store) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }

export interface BudgetView {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spentLabel: string; remainAmount: string; remainLabel: string; remainColor: string;
  postedPct: number; pendingPct: number; targetPct: number; postedColor: string;
  pendingTint: string; paceLabel: string; paceColor: string; over: boolean;
}

export function budgetViews(s: Store): { rows: BudgetView[]; totBudget: number; totSpent: number; totRemain: number } {
  const elapsed = elapsedFrac(s);
  let totBudget = 0, totSpent = 0, totRemain = 0;
  const rows: BudgetView[] = [];
  for (const b of s.budgets) {
    const c = s.cat(b.id);
    if (!c) continue;
    const extra = s.extraFor(b.id);
    const pending = b.pending + extra, posted = b.posted, spent = posted + pending, remain = b.budget - spent;
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

export interface TxView {
  id: string; merchant: string; amountLabel: string; amountColor: string;
  isPending: boolean; icon: string; iconColor: string; chipBg: string;
  catLabel: string; catColor: string; catWeight: '500' | '700'; tappable: boolean;
}

export function txView(s: Store, t: Txn): TxView {
  const isUncat = t.catId === null, isIncome = t.catId === 'income';
  const c = isUncat || isIncome ? undefined : s.cat(t.catId);
  const key = isUncat ? 'q' : isIncome ? 'home' : c ? c.icon : 'q';
  const amtStr = (t.amount < 0 ? '-' : '+') + '$' + Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: t.id, merchant: t.merchant, amountLabel: amtStr, amountColor: t.amount > 0 ? '#35d9a0' : '#f1f1f4',
    isPending: t.status === 'pending', icon: key,
    iconColor: isUncat ? '#c9b3f5' : isIncome ? '#9aa2b5' : c!.color,
    chipBg: isUncat ? 'rgba(160,130,240,.16)' : isIncome ? 'rgba(154,162,181,.14)' : tint(c!.color, 0.15),
    catLabel: isUncat ? 'Uncategorized' : isIncome ? 'Income' : c!.name,
    catColor: isUncat ? '#c9b3f5' : isIncome ? '#9aa2b5' : '#9a9aa4',
    catWeight: isUncat ? '700' : '500', tappable: isUncat,
  };
}

export function txGroups(s: Store, tab: 'all' | 'uncat') {
  const tabFilter = (t: Txn) => (tab === 'uncat' ? t.countsToBudget && t.catId === null : true);
  return DATE_ORDER
    .map((label) => ({ label, items: s.txns.filter((t) => (t.date || t.day) === label && tabFilter(t)) }))
    .filter((g) => g.items.length);
}

export function uncatCount(s: Store) {
  return s.txns.filter((t) => t.countsToBudget && t.catId === null).length;
}

export function budgetDetail(s: Store, catId: string) {
  const c = s.cat(catId);
  const b = s.budgets.find((x) => x.id === catId);
  if (!c || !b) return null;
  const elapsed = elapsedFrac(s);
  const extra = s.extraFor(b.id);
  const pending = b.pending + extra, posted = b.posted, spent = posted + pending;
  const over = spent > b.budget;
  const postedPct = Math.max(0, Math.min(100, (posted / b.budget) * 100));
  const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
  const remain = b.budget - spent;
  const daily = remain > 0 ? remain / Math.max(1, s.daysLeft) : 0;
  const relGroups = DATE_ORDER
    .map((label) => ({ label, items: s.txns.filter((t) => t.catId === b.id && (t.date || t.day) === label) }))
    .filter((g) => g.items.length);
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

export function budgetEditInfo(s: Store, catId: string) {
  const c = s.cat(catId);
  const existing = s.budgets.find((b) => b.id === catId);
  const avg = c ? Math.round(c.recent) : 0;
  const last = Math.round(avg * 0.92);
  const rec = avg; // recommendBasis default: Recent average
  const cn = s.cycleName();
  const histVals = [0.7, 0.5, 0.9, 0.6, 1.0, 0.8];
  const histLabels = ['F1', 'F2', 'F3', 'F4', 'F5', 'Now'];
  const histBars = histVals.map((v, i) => ({ h: Math.round(14 + v * 76), label: histLabels[i], last: i === 5 }));
  return {
    cat: c, existing, avg, last, rec,
    recLabel: fmt(rec), lastLabel: fmt(last), avgLabel: fmt(avg),
    periodLabel: cn.toUpperCase(),
    lastWord: cn === 'Weekly' ? 'week' : cn === 'Monthly' ? 'month' : 'fortnight',
    recommendCta: 'Use my average spend',
    histBars,
    title: existing ? 'Edit budget' : 'Set budget',
    saveText: existing ? 'Update budget' : 'Add budget',
  };
}

export function goalView(s: Store) {
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
