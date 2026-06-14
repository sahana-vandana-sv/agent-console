'use client';

import { useMemo, useState } from 'react';
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

export function ContextInspector({ contextSnapshots, isOpen, onToggle }: Props) {
  const contextIds = Array.from(contextSnapshots.keys());
  const [activeCtx, setActiveCtx] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Validate activeCtx against the CURRENT map — it may be stale from a previous
  // conversation turn (USER_MESSAGE_SENT resets the map but not local component state).
  const currentCtx =
    activeCtx !== null && contextSnapshots.has(activeCtx)
      ? activeCtx
      : contextIds[0] ?? null;

  const history = currentCtx ? (contextSnapshots.get(currentCtx) ?? []) : [];

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

  const addedKeys = useMemo(
    () => new Set(diff.added.map((e) => e.key)),
    [diff],
  );

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
                onSelect={(i) => setActiveIndex(i)}
              />
              {prevSnapshot && <DiffView diff={diff} />}
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {snapshot && (
                  <JsonTree data={snapshot.data} highlightKeys={addedKeys} />
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
}
