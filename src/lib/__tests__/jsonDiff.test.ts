import { jsonDiff } from '../jsonDiff';

describe('jsonDiff', () => {
  it('key added at top level', () => {
    const result = jsonDiff({ a: 1 }, { a: 1, b: 2 });
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ key: 'b', type: 'added', newValue: 2 });
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('key removed at top level', () => {
    const result = jsonDiff({ a: 1, b: 2 }, { a: 1 });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({ key: 'b', type: 'removed', oldValue: 2 });
    expect(result.added).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('nested value changed (reference inequality)', () => {
    const obj1 = { x: { nested: true } };
    const obj2 = { x: { nested: false } };
    const result = jsonDiff(obj1, obj2);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ key: 'x', type: 'changed' });
    expect(result.changed[0].oldValue).toBe(obj1.x);
    expect(result.changed[0].newValue).toBe(obj2.x);
  });

  it('key added + key removed in same diff', () => {
    const result = jsonDiff({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(result.added).toHaveLength(1);
    expect(result.added[0].key).toBe('c');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].key).toBe('b');
    expect(result.changed).toHaveLength(0);
  });

  it('array replaced with different array', () => {
    const prev = { items: [1, 2, 3] };
    const next = { items: [1, 2, 3, 4] };
    // Different array references → changed
    const result = jsonDiff(prev, next);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].key).toBe('items');
  });

  it('no diff when objects are identical (same references)', () => {
    const shared = { x: 1 };
    const result = jsonDiff(shared, shared);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('empty objects produce empty diff', () => {
    const result = jsonDiff({}, {});
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('550KB object diffs in < 100ms', () => {
    // Build a ~550KB object: 64 tables, each with ~8KB of data
    const tables: Record<string, unknown> = {};
    for (let i = 0; i < 64; i++) {
      tables[`table_${i}`] = {
        columns: Array.from({ length: 20 }, (_, j) => ({ name: `col_${j}`, type: 'varchar' })),
        rowCount: 1_000_000 + i,
        indexes: Array.from({ length: 5 }, (_, j) => `idx_${i}_${j}`),
      };
    }
    const next = { ...tables, analysis_complete: true, flagged_issues: ['none'] };

    const start = performance.now();
    const result = jsonDiff(tables, next);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(result.added).toHaveLength(2);
    expect(result.added.map(e => e.key).sort()).toEqual(['analysis_complete', 'flagged_issues']);
  });
});
