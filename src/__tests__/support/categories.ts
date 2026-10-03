// The sample categories the tests seed, kept in one place (WHIT-718). Frozen so no test can change
// them for the next one; spread to make a variant ({ ...COFFEE, recent: 0 }).
import type { Category } from '../../types';

export const COFFEE_RECORD = Object.freeze({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' } as const);

export const COFFEE: Category = Object.freeze({ ...COFFEE_RECORD, color: '#E8A87C', recent: 52 });

export const GROCERIES: Category = Object.freeze({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 });

export const SUBS: Category = Object.freeze({ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 });
