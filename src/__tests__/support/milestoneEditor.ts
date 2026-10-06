// WHIT-776 — shared ../context stand-in for the milestone editor suites. Usage:
//   jest.mock('../context', () => require('./support/milestoneEditor').milestoneEditorContextMockModule());
import { jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import type { MilestoneRecord } from '../../api';
import { realContextWith } from './contextMock';

export const saveMilestonesSpy = jest.fn(async (_rows: MilestoneRecord[]) => true);
export const showToastSpy = jest.fn();

// The editor's label box for row i.
export const milestoneLabelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

export function milestoneEditorContextMockModule() {
  return realContextWith(() => ({ saveMilestones: saveMilestonesSpy, showToast: showToastSpy }));
}
