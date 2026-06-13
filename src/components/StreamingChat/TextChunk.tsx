import { useEffect, useRef } from 'react';
import type { TextSegment } from '../../types/state';

interface Props {
  segment: TextSegment;
  isActive: boolean;
  onClick: (segmentId: string) => void;
}

export function TextChunk({ segment, isActive, onClick }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);

  // Scroll into view when the timeline activates this segment
  useEffect(() => {
    if (isActive) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive]);

  return (
    <p
      ref={ref}
      onClick={() => onClick(segment.id)}
      className={`cursor-pointer whitespace-pre-wrap break-words rounded text-sm leading-7 transition-colors ${
        isActive
          ? 'bg-blue-50 text-zinc-900 ring-1 ring-blue-300 dark:bg-blue-900/30 dark:text-zinc-100 dark:ring-blue-700'
          : 'text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800/40'
      }`}
    >
      {segment.content}
    </p>
  );
}
