'use client';

import { startTransition, useState } from 'react';

/**
 * How many children to mount on first expand.
 * Subsequent "show more" clicks add another PAGE_SIZE.
 *
 * Rationale: the 550KB large_context schema has 64 top-level keys, each a
 * table object with sub-keys (columns, indexes, constraints…). Expanding a
 * table that has 200+ columns would previously mount all 200 <JsonNode>s in
 * one synchronous pass. With chunking, the user sees the first 50 immediately
 * and opts in to loading more — the tab never freezes.
 */
const PAGE_SIZE = 50;

interface Props {
  data: Record<string, unknown>;
  /**
   * Marker map built from jsonDiff output — covers added, changed, and removed
   * keys. Previously only `added` keys were passed (as a Set<string>), which
   * meant `changed` keys like `tables` got no highlight in the tree.
   */
  diffMarkers?: Map<string, 'added' | 'changed' | 'removed'>;
}

// Per-marker background colour.
// added   → green   (new key in this snapshot)
// changed → amber   (key exists in both but value differs)
// removed → red     (key present in previous snapshot, absent now)
const MARKER_CLASS: Record<'added' | 'changed' | 'removed', string> = {
  added:   'bg-green-50 dark:bg-green-900/20',
  changed: 'bg-amber-50 dark:bg-amber-900/20',
  removed: 'bg-red-50 dark:bg-red-900/20 line-through opacity-60',
};

export function JsonTree({ data, diffMarkers }: Props) {
  const keys = Object.keys(data);

  return (
    <div className="font-mono text-xs">
      {keys.map((key) => (
        <JsonNode
          key={key}
          nodeKey={key}
          value={data[key]}
          marker={diffMarkers?.get(key)}
        />
      ))}
    </div>
  );
}

/** Syntax-highlighted primitive value — colour by type, not one flat green. */
function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null)
    return <span className="text-zinc-400 dark:text-zinc-500">null</span>;
  if (value === undefined)
    return <span className="text-zinc-400 dark:text-zinc-500">undefined</span>;
  if (typeof value === 'boolean')
    return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="text-sky-600 dark:text-sky-400">{String(value)}</span>;
  if (typeof value === 'string')
    return <span className="text-emerald-700 dark:text-emerald-400">&quot;{value}&quot;</span>;
  // fallback for symbol / bigint
  return <span className="text-zinc-500">{JSON.stringify(value)}</span>;
}

function JsonNode({ nodeKey, value, marker }: {
  nodeKey: string;
  value: unknown;
  marker: 'added' | 'changed' | 'removed' | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  // visibleCount controls how many children are mounted when expanded.
  // Starts at PAGE_SIZE; each "show more" click adds another PAGE_SIZE.
  // Resets to PAGE_SIZE when the node collapses so re-expand is always fast.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const isObject = value !== null && typeof value === 'object';
  const markerClass = marker ? MARKER_CLASS[marker] : '';

  const entries = isObject
    ? Object.entries(value as Record<string, unknown>)
    : [];
  const totalChildren = entries.length;
  const visibleEntries = entries.slice(0, visibleCount);
  const hiddenCount = totalChildren - visibleCount;

  function handleToggle() {
    if (!isObject) return;
    startTransition(() => {
      setExpanded((v) => {
        if (v) setVisibleCount(PAGE_SIZE); // collapse → reset chunk size
        return !v;
      });
    });
  }

  function handleShowMore() {
    startTransition(() => setVisibleCount((n) => n + PAGE_SIZE));
  }

  return (
    <div className={`rounded py-0.5 ${markerClass}`}>
      <button
        className="flex w-full items-start gap-1 text-left"
        onClick={handleToggle}
      >
        {/* Key — violet */}
        <span className="text-violet-600 dark:text-violet-400">{nodeKey}</span>
        <span className="text-zinc-400">:</span>

        {isObject ? (
          /* Object / array — chevron + length hint (hint hidden when expanded) */
          <span className="text-zinc-400">
            {expanded ? '▾' : '▸'}{' '}
            {!expanded && (
              Array.isArray(value)
                ? <><span className="text-zinc-500">[</span><span className="text-sky-600 dark:text-sky-400">{(value as unknown[]).length}</span><span className="text-zinc-500">]</span></>
                : <span className="text-zinc-500">{'{'}&hellip;{'}'}</span>
            )}
          </span>
        ) : (
          /* Primitive — syntax coloured by type */
          <PrimitiveValue value={value} />
        )}

        {/* Diff badge */}
        {marker && (
          <span className={`ml-auto shrink-0 rounded px-1 text-[10px] font-semibold ${
            marker === 'added'   ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' :
            marker === 'changed' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' :
                                   'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
          }`}>
            {marker}
          </span>
        )}
      </button>

      {isObject && expanded && (
        <div className="ml-4 border-l border-zinc-200 pl-2 dark:border-zinc-700">
          {visibleEntries.map(([k, v]) => (
            <JsonNode key={k} nodeKey={k} value={v} marker={undefined} />
          ))}

          {/* "Show more" footer — only rendered when children are chunked */}
          {hiddenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleShowMore(); }}
              className="mt-1 text-[10px] text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              show {Math.min(hiddenCount, PAGE_SIZE)} more
              <span className="ml-1 text-zinc-400">({hiddenCount} remaining)</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
