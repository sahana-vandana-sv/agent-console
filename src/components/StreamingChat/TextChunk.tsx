import { memo, useEffect, useRef } from 'react';
import type { TextSegment } from '../../types/state';

interface Props {
  segment: TextSegment;
  isActive: boolean;
  onClick: (segmentId: string) => void;
}

/**
 * memo: once a TextSegment is frozen (after TOOL_CALL), its props never change.
 * Without memo every TOKENS_BATCH dispatch (post-tool streaming) would re-render
 * every frozen TextChunk even though the output is identical.
 */
export const TextChunk = memo(function TextChunk({ segment, isActive, onClick }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);
  // 🖼️ RENDER COUNTER — open Chrome DevTools → Console, filter by "🖼️"
  // memo should prevent re-renders of FROZEN segments (those before a TOOL_CALL)
  const renderCount = useRef(0);
  renderCount.current += 1;
  console.log(
    '%c🖼️ TextChunk RENDER', 'color:#34d399',
    `id=${segment.id} render#${renderCount.current} chars=${segment.content.length} isActive=${isActive}`,
    renderCount.current > 1 ? '← RE-RENDER' : '← first render'
  );

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
});
