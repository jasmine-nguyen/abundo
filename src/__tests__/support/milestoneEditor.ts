// WHIT-776 — shared stand-in for ../context in the milestone editor suites: the editor reads
// saveMilestones/showToast off useAppContext; the rest of ../context stays real. Usage:
//
//   jest.mock('../context', () => require('./support/milestoneEditor').milestoneEditorContextMockModule());
//   import { saveMilestonesSpy, showToastSpy, milestoneLabelAt } from './support/milestoneEditor';
//
// The jest.mock factory uses require() (not the import) so it survives hoisting; both resolve to
// this one module instance, so the spies and the mock are the same functions.
import { jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import type { MilestoneRecord } from '../../api';

export const saveMilestonesSpy = jest.fn(async (_rows: MilestoneRecord[]) => true);
export const showToastSpy = jest.fn();

// The editor's label box for row i.
export const milestoneLabelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

export function milestoneEditorContextMockModule() {
  const actual = jest.requireActual('../../context') as typeof import('../../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: saveMilestonesSpy, showToast: showToastSpy }) };
}
