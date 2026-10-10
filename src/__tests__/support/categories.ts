// The sample categories the tests seed, kept in one place (WHIT-718, WHIT-719; income + Savings from WHIT-714). Frozen so no test can change
// them for the next one; spread to make a variant ({ ...COFFEE, name: 'Tea' }). A *_RECORD is the raw server
// record: seed it into the fake server, which leaves colour to the app (WHIT-721).
import type { Category } from '../../types';

export const COFFEE_RECORD = Object.freeze({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' } as const);

export const COFFEE: Category = Object.freeze({ ...COFFEE_RECORD, color: '#E8A87C' });

export const GROCERIES_RECORD = Object.freeze({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart' } as const);

export const GROCERIES: Category = Object.freeze({ ...GROCERIES_RECORD, color: '#7fd49b' });

export const SUBS: Category = Object.freeze({ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a' });

export const SALARY: Category = Object.freeze({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'cash', color: '#7fd1b9' });

export const SAVINGS: Category = Object.freeze({ id: 'rainy', name: 'Rainy Day', bucket: 'Savings', icon: 'piggy-bank', color: '#9ad' });

export const GROCERIES_TOP_RECORD = Object.freeze({ ...GROCERIES_RECORD, parent: null } as const);

export const GROCERIES_TOP = Object.freeze({ ...GROCERIES_TOP_RECORD, color: '#7FD49B' } as const);

export const SUBSCRIPTIONS_RECORD = Object.freeze({ id: 'subs', name: 'Subscriptions', icon: 'film', bucket: 'Lifestyle' } as const);

export const SUBSCRIPTIONS = Object.freeze({ ...SUBSCRIPTIONS_RECORD, color: '#f0b27a' } as const);

export const COFFEE_SHORT = Object.freeze({ id: 'coffee', name: 'Coffee', icon: 'coffee', bucket: 'Lifestyle' } as const);

const ESSENTIAL_GROCERIES_RECORD = Object.freeze({ id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Essentials' } as const);

export const ESSENTIAL_GROCERIES_TOP = Object.freeze({ ...ESSENTIAL_GROCERIES_RECORD, parent: null } as const);

export const DINING = Object.freeze({ id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e' } satisfies Category);

export const LATTE: Category = Object.freeze({ ...COFFEE, id: 'latte', name: 'Lattes', parent: 'coffee' });

export const MORTGAGE_RECORD = Object.freeze({ id: 'mortgage', name: 'Mortgage', bucket: 'Living', icon: 'home' } as const);
