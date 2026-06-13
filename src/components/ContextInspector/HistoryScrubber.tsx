'use client';

import type { ContextSnapshot } from '../../types/state';

interface Props {
  history: ContextSnapshot[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function HistoryScrubber({ history, activeIndex, onSelect }: Props) {
  if (history.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
      <span className="text-xs text-zinc-400">Snapshot</span>
      <input
        type="range"
        min={0}
        max={history.length - 1}
        value={activeIndex}
        onChange={(e) => onSelect(Number(e.target.value))}
        className="flex-1"
      />
      <span className="text-xs text-zinc-400">{activeIndex + 1}/{history.length}</span>
    </div>
  );
}
