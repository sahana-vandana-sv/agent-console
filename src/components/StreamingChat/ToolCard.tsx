'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { ToolSegment } from '../../types/state';

interface Props {
  segment: ToolSegment;
  isActive: boolean;
  onClick: (segmentId: string) => void;
}

function JsonCollapse({ value, label }: { value: unknown; label: string }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="mt-1">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <span className="font-mono">{open ? '▼' : '▶'}</span>
        <span>{label}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {json}
        </pre>
      )}
    </div>
  );
}

/**
 * memo: the card only needs to re-render when status or result changes (TOOL_RESULT).
 * Without memo it re-renders on every TOKENS_BATCH dispatch during pre-tool streaming.
 */
export const ToolCard = memo(function ToolCard({ segment, isActive, onClick }: Props) {
  const isPending = segment.status === 'pending';
  const ref = useRef<HTMLDivElement>(null);
  // Scroll into view when the timeline activates this card
  useEffect(() => {
    if (isActive) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive]);

  return (
    <div
      ref={ref}
      onClick={() => onClick(segment.id)}
      className={`my-2 min-h-[64px] cursor-pointer rounded-lg border px-4 py-3 transition-colors ${
        isActive
          ? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-900/30'
          : 'border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        {isPending ? (
          <span
            aria-label="loading"
            className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
          />
        ) : (
          <span className="h-3 w-3 rounded-full bg-green-500" />
        )}
        <span className="font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          {segment.toolName}
        </span>
        {/* transition-colors animates the pending→done badge change over 300ms */}
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-300 ${
            isPending
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
              : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
          }`}
        >
          {isPending ? 'running…' : 'done'}
        </span>
      </div>

      {/* Args */}
      <JsonCollapse value={segment.args} label="args" />

      {/* Result — only shown when resolved */}
      {!isPending && segment.result !== undefined && (
        <JsonCollapse value={segment.result} label="result" />
      )}
    </div>
  );
});
