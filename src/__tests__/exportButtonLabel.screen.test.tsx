// WHIT-703 QA — the Export button tells screen-reader users the file is an Excel file.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ExportButton } from '../components/ExportButton';

jest.mock('../cycleShare', () => ({ shareCycleExport: jest.fn() }));

// [A14] (P1) the accessibility label says "Excel file", not "CSV file".
it('the Export button is labelled as exporting an Excel file', () => {
  render(<ExportButton cycle={0} category={() => undefined} />);
  expect(screen.getByLabelText("Export this cycle's transactions as an Excel file")).toBeTruthy();
  expect(screen.queryByLabelText(/CSV/)).toBeNull();
});
