// Order-free copy detection for the one-home sample guards (WHIT-719): a line spells out a copy of a
// sample when one of its one-line `{ key: value, ... }` literals has exactly the sample's keys and values.

// Every one-line `{ key: value, ... }` on the line, read as a plain object (string, number or null values only).
export function inlineObjects(line: string): Record<string, unknown>[] {
  return (line.match(/\{[^{}]*\}/g) ?? []).map((literal) => {
    const record: Record<string, unknown> = {};
    for (const [, key, value] of literal.matchAll(/(\w+): ('[^']*'|null|-?\d+)/g)) {
      if (value === 'null') record[key] = null;
      else if (value.startsWith("'")) record[key] = value.slice(1, -1);
      else record[key] = Number(value);
    }
    return record;
  });
}

const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([key, value]) => a[key] === value);

export const isCopyOf = (sample: Record<string, unknown>) => (line: string) =>
  inlineObjects(line).some((record) => sameRecord(record, sample));
