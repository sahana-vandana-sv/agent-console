'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment, TextSegment, TraceEvent } from '../../types/state';
import { FilterBar } from './FilterBar';
import {
  TokenGroupRowView,
  ToolCallRowView,
  ToolResultRowView,
  OtherRowView,
  type DisplayRow,
} from './TimelineRow';

interface Props {
  events: TraceEvent[];
  /** Chat segments — used to reliably map token groups to their TextSegment */
  segments: Segment[];
  isOpen: boolean;
  onToggle: () => void;
  /** Segment id currently active in the chat (from chat → timeline direction) */
  activeSegmentId: string | null;
  /** Called when the user clicks a timeline row (timeline → chat direction) */
  onSegmentFocus: (segmentId: string | null) => void;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Given the current TextSegments and the first seq number of a token group,
 * return the id of the text segment that contains those tokens.
 *
 * Strategy: a TextSegment's id is `text-${seqStart}`. Each TOKEN trace event's
 * `seq` is the maxSeq of that batch, so it is always >= the segment's seqStart.
 * We pick the text segment with the largest seqStart that is still <= groupFirstSeq.
 *
 * This is O(n textSegments) and completely independent of the trace-event payload.
 */
function resolveSegmentId(
  textSegments: TextSegment[],
  groupFirstSeq: number,
): string | undefined {
  let best: TextSegment | undefined;
  for (const seg of textSegments) {
    if (seg.seqStart <= groupFirstSeq) {
      if (!best || seg.seqStart > best.seqStart) best = seg;
    }
  }
  return best?.id;
}

/**
 * Merge consecutive TOKEN events into token-group rows; keep other events as-is.
 * O(n events). Wrapped in useMemo — only recomputes when events or textSegments change.
 */
function buildDisplayRows(
  events: TraceEvent[],
  textSegments: TextSegment[],
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let tokenRun: TraceEvent[] | null = null;

  const flushTokenRun = () => {
    if (!tokenRun || tokenRun.length === 0) return;
    const first = tokenRun[0]!;
    const last  = tokenRun[tokenRun.length - 1]!;
    const totalTokens = tokenRun.reduce(
      (sum, ev) => sum + ((ev.payload.count as number | undefined) ?? 1),
      0,
    );
    // Resolve which TextSegment this group belongs to via seq-range matching.
    // Falls back to the stored payload field in case textSegments are not yet
    // fully populated (e.g. mid-stream snapshot).
    const segmentId =
      resolveSegmentId(textSegments, first.seq) ??
      (last.payload.segmentId as string | undefined);

    // Include the text content so the expanded view can show it
    const matchedSeg = segmentId
      ? textSegments.find((s) => s.id === segmentId)
      : undefined;

    rows.push({
      kind: 'token_group',
      id: first.id,
      events: tokenRun,
      totalTokens,
      durationMs: last.timestamp - first.timestamp,
      startTs: first.timestamp,
      segmentId,
      textContent: matchedSeg?.content,
    });
    tokenRun = null;
  };

  for (const ev of events) {
    if (ev.type === 'TOKEN') {
      if (!tokenRun) tokenRun = [];
      tokenRun.push(ev);
    } else {
      flushTokenRun();
      if (ev.type === 'TOOL_CALL') {
        rows.push({
          kind: 'tool_call',
          id: ev.id,
          event: ev,
          callId:   (ev.payload.callId as string) ?? '',
          toolName: (ev.payload.toolName as string) ?? '',
        });
      } else if (ev.type === 'TOOL_RESULT') {
        rows.push({
          kind: 'tool_result',
          id: ev.id,
          event: ev,
          callId: (ev.payload.callId as string) ?? '',
        });
      } else {
        rows.push({ kind: 'other', id: ev.id, event: ev });
      }
    }
  }
  flushTokenRun();
  return rows;
}

// ─── Row renderer (memo'd to prevent full-list re-renders on every token) ────

const RowRenderer = memo(function RowRenderer({
  row,
  isActive,
  onFocus,
  rowRef,
}: {
  row: DisplayRow;
  isActive: boolean;
  onFocus: (segmentId: string | null) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const focus = useCallback(
    (sid: string | undefined) => onFocus(sid ?? null),
    [onFocus],
  );

  if (row.kind === 'token_group') {
    return <TokenGroupRowView row={row} isActive={isActive} onFocus={focus} rowRef={rowRef} />;
  }
  if (row.kind === 'tool_call') {
    return <ToolCallRowView row={row} isActive={isActive} onFocus={focus} rowRef={rowRef} />;
  }
  if (row.kind === 'tool_result') {
    return <ToolResultRowView row={row} isActive={isActive} onFocus={focus} rowRef={rowRef} />;
  }
  return <OtherRowView row={row} isActive={isActive} onFocus={focus} rowRef={rowRef} />;
});

// ─── Main component ───────────────────────────────────────────────────────────

export const TraceTimeline = memo(function TraceTimeline({
  events,
  segments,
  isOpen,
  onToggle,
  activeSegmentId,
  onSegmentFocus,
}: Props) {
  const [typeFilter, setTypeFilter]     = useState('ALL');
  const [searchFilter, setSearchFilter] = useState('');

  const scrollRef   = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const rowRefs     = useRef<Map<string, HTMLDivElement>>(new Map());

  // Extract text segments once for seq-range matching
  const textSegments = useMemo(
    () => segments.filter((s): s is TextSegment => s.type === 'text'),
    [segments],
  );

  // Grouping — O(n events). Only recomputes when events or text segments change.
  const allRows = useMemo(
    () => buildDisplayRows(events, textSegments),
    [events, textSegments],
  );

  // Filtering
  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      if (typeFilter !== 'ALL') {
        const rowType =
          row.kind === 'token_group'  ? 'TOKEN'
          : row.kind === 'tool_call'  ? 'TOOL_CALL'
          : row.kind === 'tool_result'? 'TOOL_RESULT'
          : row.kind === 'other'      ? row.event.type
          : '';
        if (rowType !== typeFilter) return false;
      }
      if (searchFilter) {
        const haystack =
          row.kind === 'token_group'
            ? `TOKEN ${row.totalTokens} ${row.segmentId ?? ''}`
            : JSON.stringify(
                row.kind === 'tool_call' || row.kind === 'tool_result'
                  ? row.event.payload
                  : row.kind === 'other' ? row.event.payload : '',
              );
        if (!haystack.toLowerCase().includes(searchFilter.toLowerCase())) return false;
      }
      return true;
    });
  }, [allRows, typeFilter, searchFilter]);

  // Active row — works in both directions:
  //   timeline click → activeSegmentId set → row highlighted
  //   chat click     → activeSegmentId set → row highlighted + scrolled to
  const activeRowId = useMemo(() => {
    if (!activeSegmentId) return null;
    for (const row of filteredRows) {
      if (row.kind === 'token_group'  && row.segmentId === activeSegmentId) return row.id;
      if (row.kind === 'tool_call'    && row.callId    === activeSegmentId) return row.id;
      if (row.kind === 'tool_result'  && row.callId    === activeSegmentId) return row.id;
    }
    return null;
  }, [filteredRows, activeSegmentId]);

  // Track whether user has scrolled up
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Auto-scroll to bottom when new rows arrive (unless user scrolled up)
  useEffect(() => {
    if (!isOpen || !atBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [filteredRows.length, isOpen]);

  // Scroll to the active row (chat → timeline direction)
  useEffect(() => {
    if (!isOpen || !activeRowId) return;
    rowRefs.current.get(activeRowId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeRowId, isOpen]);

  return (
    <div className="flex h-full flex-col border-l border-zinc-200 dark:border-zinc-700">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/50"
      >
        <span>{isOpen ? '▶' : '◀'}</span>
        <span>Trace</span>
        <span className="ml-auto font-normal text-zinc-400">{events.length}</span>
      </button>

      {isOpen && (
        <>
          <FilterBar
            typeFilter={typeFilter}
            searchFilter={searchFilter}
            onTypeChange={setTypeFilter}
            onSearchChange={setSearchFilter}
          />

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="relative flex-1 overflow-y-auto"
          >
            {filteredRows.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-zinc-400">No events</p>
            ) : (
              filteredRows.map((row) => (
                <RowRenderer
                  key={row.id}
                  row={row}
                  isActive={row.id === activeRowId}
                  onFocus={onSegmentFocus}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
});
