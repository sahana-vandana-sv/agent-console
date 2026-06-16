'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment, TextSegment, TraceEvent } from '../../types/state';
import { FilterBar } from './FilterBar';
import {
  TokenGroupRowView,
  ToolCallRowView,
  ToolResultRowView,
  PingPongRowView,
  OtherRowView,
  type DisplayRow,
  type ToolCallRow,
  type TokenGroupRow,
  type PingPongRow,
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
 * Then merge ALL token_group rows into a single summary row so the timeline shows
 * one "Streamed N tokens" entry per stream rather than one per text segment.
 *
 * Why merge after building instead of during: tool calls flush the in-progress
 * token run (to preserve ordering), which would produce two token_group rows for
 * a script like "report" (tokens → tool_call → tokens). The merge pass runs after
 * the full row list is built, so ordering of tool_call rows is preserved while all
 * token data is collapsed into a single summary.
 *
 * O(n events). Wrapped in useMemo — only recomputes when events or textSegments change.
 */
function buildDisplayRows(
  events: TraceEvent[],
  textSegments: TextSegment[],
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let tokenRun: TraceEvent[] | null = null;
  const pendingToolCalls = new Map<string, { rowIndex: number; interstitial: TraceEvent[] }>();
  // PING seq → index in rows[] so PONG can attach to the right row
  const pendingPings = new Map<number, number>();

  const flushTokenRun = () => {
    if (!tokenRun || tokenRun.length === 0) return;
    const first = tokenRun[0]!;
    const last  = tokenRun[tokenRun.length - 1]!;
    const totalTokens = tokenRun.reduce(
      (sum, ev) => sum + ((ev.payload.count as number | undefined) ?? 1),
      0,
    );
    const segmentId =
      resolveSegmentId(textSegments, first.seq) ??
      (last.payload.segmentId as string | undefined);
    const matchedSeg = segmentId
      ? textSegments.find((s) => s.id === segmentId)
      : undefined;
    const firstArrival = (first.payload.firstArrivalTs as number | undefined) ?? first.timestamp;
    const lastArrival  = (last.payload.lastArrivalTs   as number | undefined) ?? last.timestamp;

    rows.push({
      kind: 'token_group',
      id: first.id,
      events: tokenRun,
      totalTokens,
      durationMs: lastArrival - firstArrival,
      startTs: firstArrival,
      segmentIds: segmentId ? [segmentId] : [],
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
        const callId = (ev.payload.callId as string) ?? '';
        const rowIndex = rows.length;
        rows.push({
          kind: 'tool_call',
          id: ev.id,
          event: ev,
          callId,
          toolName: (ev.payload.toolName as string) ?? '',
        });
        pendingToolCalls.set(callId, { rowIndex, interstitial: [] });
      } else if (ev.type === 'TOOL_RESULT') {
        const callId = (ev.payload.callId as string) ?? '';
        const pending = pendingToolCalls.get(callId);
        if (pending) {
          (rows[pending.rowIndex] as ToolCallRow).resultEvent = ev;
          pendingToolCalls.delete(callId);
          for (const ie of pending.interstitial) {
            rows.push({ kind: 'other', id: ie.id, event: ie });
          }
        } else {
          rows.push({ kind: 'tool_result', id: ev.id, event: ev, callId });
        }
      } else if (ev.type === 'PING') {
        const rowIndex = rows.length;
        rows.push({ kind: 'ping_pong', id: ev.id, pingEvent: ev });
        pendingPings.set(ev.seq, rowIndex);
      } else if (ev.type === 'PONG') {
        // Attach to the most recent unmatched PING (seq on PONG is its own seq, not the ping's)
        // We match by insertion order: the latest pendingPing entry
        let matched = false;
        for (const [pingSeq, rowIndex] of pendingPings) {
          (rows[rowIndex] as PingPongRow).pongEvent = ev;
          pendingPings.delete(pingSeq);
          matched = true;
          break;
        }
        if (!matched) {
          rows.push({ kind: 'other', id: ev.id, event: ev });
        }
      } else {
        const activePending = [...pendingToolCalls.values()];
        if (activePending.length > 0) {
          activePending[activePending.length - 1]!.interstitial.push(ev);
        } else {
          rows.push({ kind: 'other', id: ev.id, event: ev });
        }
      }
    }
  }
  flushTokenRun();
  for (const { interstitial } of pendingToolCalls.values()) {
    for (const ie of interstitial) {
      rows.push({ kind: 'other', id: ie.id, event: ie });
    }
  }

  return mergeTokenGroups(rows);
}

/**
 * Post-processing: collapse all token_group rows into a single summary row.
 *
 * Result: one "Streamed N tokens (Xs)" row per stream, regardless of how many
 * text segments the response has (e.g. tokens before + after a tool call).
 * Expanding the row shows the full concatenated response text.
 *
 * Non-token rows (tool_call, PING/PONG, STREAM_END, etc.) remain in their
 * original positions. If there is only one token_group, it is returned as-is.
 */
function mergeTokenGroups(rows: DisplayRow[]): DisplayRow[] {
  const tokenRows = rows.filter((r): r is TokenGroupRow => r.kind === 'token_group');
  if (tokenRows.length <= 1) return rows;

  const totalTokens = tokenRows.reduce((s, r) => s + r.totalTokens, 0);
  const startTs     = Math.min(...tokenRows.map((r) => r.startTs));
  const durationMs  = Math.max(...tokenRows.map((r) => r.startTs + r.durationMs)) - startTs;
  const allEvents   = tokenRows.flatMap((r) => r.events);
  // Concatenate text from all segments (separated by a single space to avoid run-on words)
  const textContent = tokenRows
    .map((r) => r.textContent ?? '')
    .filter(Boolean)
    .join(' ');

  // Collect all segment IDs across the merged rows (preserving order).
  // Used for bidirectional highlight: the merged row highlights in the timeline
  // when ANY of its TextSegments is active in the chat.
  const segmentIds = tokenRows.flatMap((r) => r.segmentIds);

  const merged: TokenGroupRow = {
    kind: 'token_group',
    id: tokenRows[0]!.id,
    events: allEvents,
    totalTokens,
    durationMs,
    startTs,
    segmentIds,
    textContent: textContent || undefined,
  };

  // Insert merged row at the position of the first token_group; drop the rest
  const result: DisplayRow[] = [];
  let inserted = false;
  for (const row of rows) {
    if (row.kind === 'token_group') {
      if (!inserted) { result.push(merged); inserted = true; }
    } else {
      result.push(row);
    }
  }
  return result;
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
  if (row.kind === 'ping_pong') {
    return <PingPongRowView row={row} isActive={isActive} onFocus={focus} rowRef={rowRef} />;
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
    const result: DisplayRow[] = [];
    for (const row of allRows) {
      // ── Type filter ──────────────────────────────────────────────────────
      if (typeFilter !== 'ALL') {
        if (row.kind === 'token_group' && typeFilter !== 'TOKEN') continue;
        if (row.kind === 'ping_pong' && typeFilter !== 'PING/PONG') continue;
        if (row.kind === 'other' && row.event.type !== typeFilter) continue;
        if (row.kind === 'tool_result' && typeFilter !== 'TOOL_RESULT') continue;

        if (row.kind === 'tool_call') {
          const wantCall   = typeFilter === 'TOOL_CALL';
          const wantResult = typeFilter === 'TOOL_RESULT' && row.resultEvent !== undefined;
          if (!wantCall && !wantResult) continue;
          // Clone row with visibility hint so ToolCallRowView renders only the right half
          const visiblePart: 'call' | 'result' = wantCall ? 'call' : 'result';
          // ── Search filter (applied inside type-filter branch for tool_call)
          if (searchFilter) {
            const haystack = JSON.stringify(row.event.payload);
            if (!haystack.toLowerCase().includes(searchFilter.toLowerCase())) continue;
          }
          result.push({ ...row, visiblePart });
          continue;
        }
      }

      // ── Search filter (non-tool-call paths) ─────────────────────────────
      if (searchFilter) {
        const haystack =
          row.kind === 'token_group'
            ? `TOKEN ${row.totalTokens} ${row.segmentIds.join(' ')} ${row.textContent ?? ''}`
            : row.kind === 'ping_pong'
            ? `PING PONG ${row.pingEvent.seq}`
            : JSON.stringify(
                row.kind === 'tool_call' || row.kind === 'tool_result'
                  ? row.event.payload
                  : row.kind === 'other' ? row.event.payload : '',
              );
        if (!haystack.toLowerCase().includes(searchFilter.toLowerCase())) continue;
      }

      result.push(row);
    }
    return result;
  }, [allRows, typeFilter, searchFilter]);

  // Active row — works in both directions:
  //   timeline click → activeSegmentId set → row highlighted
  //   chat click     → activeSegmentId set → row highlighted + scrolled to
  const activeRowId = useMemo(() => {
    if (!activeSegmentId) return null;
    for (const row of filteredRows) {
      if (row.kind === 'token_group'  && row.segmentIds.includes(activeSegmentId)) return row.id;
      if (row.kind === 'tool_call'    && row.callId === activeSegmentId) return row.id;
      if (row.kind === 'tool_result'  && row.callId === activeSegmentId) return row.id;
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
