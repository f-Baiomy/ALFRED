export interface TreeEntry {
  readonly key: string | null;
  readonly value: unknown;
}

export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

/** Child entries of an object/array, in display order. Array items get `key: null`. */
export function treeEntriesOf(value: Record<string, unknown> | unknown[]): TreeEntry[] {
  if (Array.isArray(value)) {
    return value.map((v) => ({ key: null, value: v }));
  }
  return Object.entries(value).map(([key, v]) => ({ key, value: v }));
}

export function braceFor(value: Record<string, unknown> | unknown[]): { open: string; close: string; noun: string } {
  return Array.isArray(value) ? { open: '[', close: ']', noun: 'item' } : { open: '{', close: '}', noun: 'key' };
}
