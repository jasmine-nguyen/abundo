// Bucket colours (WHIT-422 / WHIT-320), moved out of src/context.tsx so the store stops doubling as
// a colour palette. Category colours live in src/chartColors.ts (applied in toCategory).
import { C } from './theme';
import type { Bucket } from './types';

export const BUCKET_COLOR: Record<Bucket, string> = {
  Living: '#7aa2f7', Lifestyle: '#bb9af7', Income: C.good, Savings: '#73daca',
};
