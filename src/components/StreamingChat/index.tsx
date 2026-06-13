'use client';

import type { Segment } from '../../types/state';
import { TextChunk } from './TextChunk';
import { ToolCard } from './ToolCard';

interface Props {
  segments: Segment[];
  phase: string;
  /** Segment id currently highlighted (from timeline → chat) */
  activeSegmentId: string | null;
  /** Called when user clicks a segment (chat → timeline) */
  onSegmentFocus: (segmentId: string) => void;
}

export function StreamingChat({ segments, phase, activeSegmentId, onSegmentFocus }: Props) {
  // Scroll is owned by page.tsx — the bottomRef lives inside the overflow-y-auto
  // container there. A second scrollIntoView here would fire simultaneously on every
  // TOKENS_BATCH dispatch, creating two competing smooth-scroll animations per frame.

  if (segments.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        {phase === 'IDLE' || phase === 'CONNECTING'
          ? 'Send a message to start…'
          : 'Waiting for response…'}
      </div>
    );
  }

  return (
    // min-height prevents layout shift when the first segment arrives
    <div className="min-h-[40px] space-y-1 px-4 py-3">
      {segments.map((seg) =>
        seg.type === 'text' ? (
          <TextChunk
            key={seg.id}
            segment={seg}
            isActive={activeSegmentId === seg.id}
            onClick={onSegmentFocus}
          />
        ) : (
          <ToolCard
            key={seg.id}
            segment={seg}
            isActive={activeSegmentId === seg.id}
            onClick={onSegmentFocus}
          />
        ),
      )}
    </div>
  );
}
