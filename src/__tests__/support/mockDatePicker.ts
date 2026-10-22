// WHIT-264 — shared configurable stand-in for @react-native-community/datetimepicker.
//
// The GLOBAL jest.setup mock fires a FIXED past date (20 Jun 2026) on every tap. Suites that need
// to drive a SPECIFIC picked date — e.g. the WHIT-257 save-time date guards, which reject a past
// target / future as-of — override the picker per-file and steer the emitted date via
// setPickedDate(). Usage in a suite:
//
//   jest.mock('@react-native-community/datetimepicker', () =>
//     require('./support/mockDatePicker').mockDatePickerModule());
//   import { setPickedDate, resetPickedDate, FUTURE, FUTURE_ISO } from './support/mockDatePicker';
//   beforeEach(() => resetPickedDate());
//
// The jest.mock factory uses require() (not the import) so it survives hoisting; both resolve to
// this one module instance, so setPickedDate() and the mock share state.
import { screen } from '@testing-library/react-native';
import { toISODate } from '../../dateutil';

// The props the screen passed to its one rendered picker (whichever mock is installed).
// Both mocks keep those props on their drawn element as `pickerProps`.
export const renderedPickerProps = (): Record<string, unknown> =>
  screen.getByTestId('mock-datepicker').props.pickerProps;

// A date always comfortably in the future regardless of when the suite runs. Relative to the real
// clock on purpose: the date guards are date-sensitive, so a hardcoded year would rot.
export const FUTURE = new Date(new Date().getFullYear() + 2, 0, 15);
export const FUTURE_ISO = toISODate(FUTURE);

let pickedDate: Date = FUTURE;

export const setPickedDate = (date: Date) => { pickedDate = date; };
export const resetPickedDate = () => { pickedDate = FUTURE; };

// The jest.mock factory body — returns a lightweight picker that emits `fixedDate` (the global
// jest.setup mock) or the current pickedDate through onChange using the real (event, date)
// signature (the Date is the SECOND arg).
export function mockDatePickerModule(fixedDate?: Date) {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props: any) => React.createElement(
    Pressable,
    { testID: 'mock-datepicker', pickerProps: props, onPress: () => props.onChange && props.onChange({ type: 'set' }, fixedDate ?? pickedDate) },
    React.createElement(Text, null, 'picker'),
  );
  return { __esModule: true, default: MockPicker };
}
