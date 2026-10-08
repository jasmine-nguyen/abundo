// The Loan details form's inputs, found by their example (placeholder) text, and one shared fill
// step. Fields left out of `values` aren't touched.
import { fireEvent, screen } from '@testing-library/react-native';

export const LOAN_FORM_PLACEHOLDERS = {
  orig: 'e.g. 500000',
  home: 'e.g. 650000',
  lvr: 'e.g. 80',
  rate: 'e.g. 6.2',
  base: 'e.g. 2500',
  extra: 'e.g. 200',
  deposit: 'e.g. 100000',
} as const;

export type LoanFormValues = Partial<Record<keyof typeof LOAN_FORM_PLACEHOLDERS, string>>;

// A valid set of the six required fields.
export const VALID_LOAN_FORM = { orig: '600000', home: '770000', lvr: '80', rate: '5.74', base: '1240', extra: '200' };

export function fillLoanForm(values: LoanFormValues) {
  for (const [field, value] of Object.entries(values) as [keyof typeof LOAN_FORM_PLACEHOLDERS, string][]) {
    fireEvent.changeText(screen.getByPlaceholderText(LOAN_FORM_PLACEHOLDERS[field]), value);
  }
}
