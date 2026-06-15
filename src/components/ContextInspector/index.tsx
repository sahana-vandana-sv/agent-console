'use client';

import { memo, useEffect, useRef, useMemo, useState } from 'react';
import type { ContextSnapshot } from '../../types/state';
import { JsonTree } from './JsonTree';
import { DiffView } from './DiffView';
import { HistoryScrubber } from './HistoryScrubber';
import { jsonDiff } from '../../lib/jsonDiff';

interface Props {
  contextSnapshots: Map<string, ContextSnapshot[]>;
  isOpen: boolean;
  onToggle: () => void;
}

// memo: contextSnapshots reference is stable across TOKENS_BATCH dispatches
// (the reducer only creates a new Map on CONTEXT_SNAPSHOT actions). With memo,
// the 550KB JsonTree is fully insulated from token streaming re-renders —
// it only re-renders when a new snapshot actually arrives.
// Requires onToggle to be stable (useCallback in page.tsx) — an inline arrow
// would create a new reference on every parent render and defeat memo.
export const ContextInspector = memo(function ContextInspector({ contextSnapshots, isOpen, onToggle }: Props) {
  const contextIds = Array.from(contextSnapshots.keys());
  const [activeCtx, setActiveCtx] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // true once the user has manually moved the scrubber — suppresses auto-advance.
  const userHasScrubbed = useRef(false);

  // Validate activeCtx against the CURRENT map — it may be stale from a previous
  // conversation turn (USER_MESSAGE_SENT resets the map but not local component state).
  const currentCtx =
    activeCtx !== null && contextSnapshots.has(activeCtx)
      ? activeCtx
      : contextIds[0] ?? null;

  const history = currentCtx ? (contextSnapshots.get(currentCtx) ?? []) : [];

  // Auto-advance scrubber to the latest snapshot when new history arrives,
  // unless the user has manually scrubbed back to an earlier snapshot.
  useEffect(() => {
    if (history.length > 0 && !userHasScrubbed.current) {
      setActiveIndex(history.length - 1);
    }
  }, [history.length]);

  // When the active context changes (tab switch or new turn), reset scrub state
  // so the next snapshot auto-advances again.
  useEffect(() => {
    userHasScrubbed.current = false;
    setActiveIndex(0);
  }, [currentCtx]);

  // Clamp activeIndex — guards against stale index when switching contexts or
  // when a new turn resets the map to fewer snapshots than before.
  const safeIndex = Math.min(activeIndex, Math.max(0, history.length - 1));
  const snapshot = history[safeIndex] ?? null;
  const prevSnapshot = safeIndex > 0 ? history[safeIndex - 1] : null;

  // Memoised diff — jsonDiff runs O(n top-level keys) but must NOT re-run on
  // every token render (streaming causes rapid re-renders). Key on seq numbers
  // so it only recomputes when the actual snapshots change.
  const diff = useMemo(
    () =>
      prevSnapshot && snapshot
        ? jsonDiff(prevSnapshot.data, snapshot.data)
        : { added: [], removed: [], changed: [] },
    [prevSnapshot?.seq, snapshot?.seq], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Build a single marker map covering all three diff categories.
  // Previously only diff.added was extracted — diff.changed and diff.removed
  // were silently discarded, so changed keys (e.g. `tables`) got no highlight.
  const diffMarkers = useMemo(() => {
    const m = new Map<string, 'added' | 'changed' | 'removed'>();
    for (const e of diff.added)   m.set(e.key, 'added');
    for (const e of diff.changed) m.set(e.key, 'changed');
    for (const e of diff.removed) m.set(e.key, 'removed');
    return m;
  }, [diff]);

  return (
    <div className="flex h-full flex-col border-l border-zinc-200 dark:border-zinc-700">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-zinc-600 dark:text-zinc-400"
      >
        <span>{isOpen ? '▶' : '◀'}</span>
        <span>Context</span>
        <span className="ml-auto text-zinc-400">{contextIds.length}</span>
      </button>

      {isOpen && (
        <>
          {/* Context ID tabs */}
          {contextIds.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-3 py-1 dark:border-zinc-700">
              {contextIds.map((id) => (
                <button
                  key={id}
                  onClick={() => { setActiveCtx(id); setActiveIndex(0); }}
                  className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                    id === currentCtx
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}
                >
                  {id}
                </button>
              ))}
            </div>
          )}

          {history.length > 0 ? (
            <>
              <HistoryScrubber
                history={history}
                activeIndex={safeIndex}
                onSelect={(i) => {
                  // User explicitly moved the scrubber — suppress auto-advance
                  // until the context changes or a new turn starts.
                  userHasScrubbed.current = true;
                  setActiveIndex(i);
                }}
              />
              {prevSnapshot && <DiffView diff={diff} />}
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {snapshot && (
                  <JsonTree data={snapshot.data} diffMarkers={diffMarkers} />
                )}
              </div>
            </>
          ) : (
            <p className="px-3 py-4 text-xs text-zinc-400">No context yet</p>
          )}
        </>
      )}
    </div>
  );
});
