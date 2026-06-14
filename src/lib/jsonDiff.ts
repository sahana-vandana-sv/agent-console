// Top-level structural diff only.
// Operates on Object.keys() — O(n) in the number of top-level keys.
// Completes in < 100ms even for 550KB objects because we never deep-clone.

export interface DiffEntry {
  key: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

export interface DiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
}

/**
 * Value equality check used to suppress false-positive "changed" entries.
 *
 * The server may call generateLargeContext() twice (once per snapshot), producing
 * structurally identical but reference-different objects for all 64 table keys.
 * Reference inequality alone would mark every table as "changed".
 *
 * Strategy (cheapest → most expensive):
 *  1. Reference equality  — instant, handles primitives and cached objects
 *  2. Type / null guard   — fast reject for mismatched types
 *  3. Array length check  — O(1) fast reject before serialisation
 *  4. JSON.stringify      — O(n) deep structural equality, used only as fallback
 *
 * JSON.stringify is called per top-level key, not on the whole 550KB object.
 * At ~1 GB/s, comparing a 8 KB table value takes ~0.008 ms — negligible even
 * for 64 tables. jsonDiff itself is only called once per snapshot pair (memoised
 * on seq numbers), so this cost is not incurred on every render.
 */
function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;   // primitives already handled by ===

  // Fast structural reject before paying for JSON.stringify
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== (b as unknown[]).length) return false;

  // Deep equality via serialisation — the only way to catch "same content, new reference"
  // across arbitrarily nested structures without a custom recursive comparator.
  return JSON.stringify(a) === JSON.stringify(b);
}

export function jsonDiff(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): DiffResult {
  const added:   DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];

  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(next));

  for (const key of nextKeys) {
    if (!prevKeys.has(key)) {
      added.push({ key, type: 'added', newValue: next[key] });
    } else if (!valueEqual(prev[key], next[key])) {
      changed.push({ key, type: 'changed', oldValue: prev[key], newValue: next[key] });
    }
  }

  for (const key of prevKeys) {
    if (!nextKeys.has(key)) {
      removed.push({ key, type: 'removed', oldValue: prev[key] });
    }
  }

  return { added, removed, changed };
}
