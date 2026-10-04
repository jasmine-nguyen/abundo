// The sample categories the tests seed, kept in one place (WHIT-718; income + Savings from WHIT-714). Frozen so no test can change
// them for the next one; spread to make a variant ({ ...COFFEE, recent: 0 }). A *_RECORD is the raw server
// record: seed it into the fake server, which leaves colour and recent to the app (WHIT-721).
import type { Category } from '../../types';

export const COFFEE_RECORD = Object.freeze({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' } as const);

export const COFFEE: Category = Object.freeze({ ...COFFEE_RECORD, color: '#E8A87C', recent: 52 });

export const GROCERIES_RECORD = Object.freeze({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart' } as const);

export const GROCERIES: Category = Object.freeze({ ...GROCERIES_RECORD, color: '#7fd49b', recent: 100 });

export const SUBS: Category = Object.freeze({ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 });

export const SALARY: Category = Object.freeze({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'cash', color: '#7fd1b9', recent: 0 });

export const SAVINGS: Category = Object.freeze({ id: 'rainy', name: 'Rainy Day', bucket: 'Savings', icon: 'piggy-bank', color: '#9ad', recent: 0 });
