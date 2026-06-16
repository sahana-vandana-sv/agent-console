'use client';

import { memo, useState } from 'react';
import type { TraceEvent } from '../../types/state';

// ─── Display row types ───────────────────────────────────────────────────────

export type TokenGroupRow = {
  kind: 'token_group';
  id: string;
  events: TraceEvent[];
  totalTokens: number;
  durationMs: number;
  startTs: number;
  /**
   * IDs of all TextSegments covered by this group.
   * May be multiple (e.g. text before + text after a tool call in the same stream).
   * Used for bidirectional highlight: timeline click focuses segmentIds[0],
   * chat TextChunk click checks segmentIds.includes(activeSegmentId).
   */
  segmentIds: string[];
  /**
   * Full concatenated text across all streamed segments — shown on expand.
   * Populated by mergeTokenGroups after all per-segment content is known.
   */
  textContent?: string;
};

export type ToolCallRow = {
  kind: 'tool_call';
  id: string;
  event: TraceEvent;
  callId: string;
  toolName: string;
  /** TOOL_RESULT event for the same callId — attached here so the pair always renders together */
  resultEvent?: TraceEvent;
  /**
   * Set by filter logic to control which sub-row renders:
   * - 'both'   (default) → show TOOL_CALL + TOOL_RESULT together
   * - 'call'   → show only the TOOL_CALL half (TOOL_RESULT filter hides it)
   * - 'result' → show only the TOOL_RESULT half (TOOL_CALL filter hides it)
   */
  visiblePart?: 'both' | 'call' | 'result';
};

export type ToolResultRow = {
  kind: 'tool_result';
  id: string;
  event: TraceEvent;
  callId: string;
};

export type PingPongRow = {
  kind: 'ping_pong';
  id: string;
  pingEvent: TraceEvent;
  /** Undefined if the connection dropped before PONG was received */
  pongEvent?: TraceEvent;
};

export type OtherRow = {
  kind: 'other';
  id: string;
  event: TraceEvent;
};

export type DisplayRow = TokenGroupRow | ToolCallRow | ToolResultRow | PingPongRow | OtherRow;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TYPE_COLOURS: Record<string, string> = {
  TOKEN:            'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  TOOL_CALL:        'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  TOOL_RESULT:      'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  CONTEXT_SNAPSHOT: 'bg-purple-50 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  PING:             'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  PONG:             'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  STREAM_END:       'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
  ERROR:            'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function TypeBadge({ type }: { type: string }) {
  const cls = TYPE_COLOURS[type] ?? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${cls}`}>
      {type}
    </span>
  );
}

function fmtMs(ms: number) {
  if (ms === 0) return '<1ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Row components (all wrapped in memo) ────────────────────────────────────

interface RowWrapperProps {
  isActive: boolean;
  onClick: () => void;
  indent?: boolean;
  children: React.ReactNode;
  rowRef?: React.Ref<HTMLDivElement>;
}

function RowWrapper({ isActive, onClick, indent = false, children, rowRef }: RowWrapperProps) {
  return (
    <div
      ref={rowRef}
      onClick={onClick}
      className={`flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 text-xs transition-colors ${
        indent ? 'pl-7' : ''
      } ${
        isActive
          ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/30'
          : 'border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
      }`}
    >
      {children}
    </div>
  );
}

// ── Token group row ───────────────────────────────────────────────────────────

interface TokenGroupProps {
  row: TokenGroupRow;
  isActive: boolean;
  onFocus: (segmentId: string | undefined) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

export const TokenGroupRowView = memo(function TokenGroupRowView({
  row,
  isActive,
  onFocus,
  rowRef,
}: TokenGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      ref={rowRef}
      className={`border-b text-xs transition-colors ${
        isActive
          ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/30'
          : 'border-zinc-100 dark:border-zinc-800'
      }`}
    >
      <div
        className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${isActive ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
        onClick={() => onFocus(row.segmentIds[0])}
      >
        <TypeBadge type="TOKEN" />
        <span className="flex-1 truncate text-zinc-600 dark:text-zinc-400">
          Streamed{' '}
          <strong className="text-zinc-800 dark:text-zinc-200">{row.totalTokens}</strong>{' '}
          tokens
          <span className="ml-1 text-zinc-400">({fmtMs(row.durationMs)})</span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
          {row.textContent && (
            <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {row.textContent}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

// ── Tool call row ─────────────────────────────────────────────────────────────

interface ToolCallProps {
  row: ToolCallRow;
  isActive: boolean;
  onFocus: (segmentId: string | undefined) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

export const ToolCallRowView = memo(function ToolCallRowView({
  row,
  isActive,
  onFocus,
  rowRef,
}: ToolCallProps) {
  const hasResult = row.resultEvent !== undefined;
  const part = row.visiblePart ?? 'both';
  const showCall   = part === 'both' || part === 'call';
  const showResult = (part === 'both' || part === 'result') && hasResult;
  // When showing only the result half, the ┬/└ connector is meaningless — use plain indent
  const connectorGlyph = part === 'result' ? '└' : (hasResult && part === 'both' ? '┬' : null);

  return (
    <div ref={rowRef} className={`border-b text-xs ${isActive ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/30' : 'border-zinc-100 dark:border-zinc-800'}`}>
      {/* TOOL_CALL row */}
      {showCall && (
        <div
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
          onClick={() => onFocus(row.callId)}
        >
          {/* Connector glyph — ┬ when paired with result, nothing otherwise */}
          <span className={`shrink-0 font-mono text-zinc-300 dark:text-zinc-600 ${connectorGlyph && part === 'both' && hasResult ? 'opacity-100' : 'opacity-0'}`}>
            ┬
          </span>
          <TypeBadge type="TOOL_CALL" />
          <span className="flex-1 truncate font-mono text-zinc-700 dark:text-zinc-300">
            {row.toolName}
          </span>
          <span className="shrink-0 truncate font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
            {row.callId.slice(0, 8)}
          </span>
        </div>
      )}
      {/* TOOL_RESULT — always adjacent when showing 'both', standalone when showing 'result' only */}
      {showResult && (
        <div
          className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${showCall ? 'border-t border-zinc-100 dark:border-zinc-800' : ''}`}
          onClick={() => onFocus(row.callId)}
        >
          <span className="shrink-0 font-mono text-zinc-300 dark:text-zinc-600">└</span>
          <TypeBadge type="TOOL_RESULT" />
          <span className="truncate font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
            {row.callId.slice(0, 8)}
          </span>
        </div>
      )}
    </div>
  );
});

// ── Tool result row ───────────────────────────────────────────────────────────

interface ToolResultProps {
  row: ToolResultRow;
  isActive: boolean;
  onFocus: (segmentId: string | undefined) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

export const ToolResultRowView = memo(function ToolResultRowView({
  row,
  isActive,
  onFocus,
  rowRef,
}: ToolResultProps) {
  return (
    <RowWrapper isActive={isActive} onClick={() => onFocus(row.callId)} indent rowRef={rowRef}>
      {/* Connector glyph */}
      <span className="shrink-0 text-zinc-300 dark:text-zinc-600">└</span>
      <TypeBadge type="TOOL_RESULT" />
      <span className="truncate font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
        {row.callId.slice(0, 8)}
      </span>
    </RowWrapper>
  );
});

// ── Ping/Pong row ─────────────────────────────────────────────────────────────

interface PingPongProps {
  row: PingPongRow;
  isActive: boolean;
  onFocus: (segmentId: string | undefined) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

export const PingPongRowView = memo(function PingPongRowView({
  row,
  isActive,
  onFocus,
  rowRef,
}: PingPongProps) {
  const hasPong = row.pongEvent !== undefined;
  return (
    <RowWrapper isActive={isActive} onClick={() => onFocus(undefined)} rowRef={rowRef}>
      <span className="w-5 shrink-0 text-right font-mono text-zinc-300 dark:text-zinc-600">
        {row.pingEvent.seq >= 0 ? row.pingEvent.seq : ''}
      </span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${TYPE_COLOURS['PING']}`}>
        PING
      </span>
      <span className="text-zinc-300 dark:text-zinc-600">/</span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${hasPong ? TYPE_COLOURS['PONG'] : 'bg-red-50 text-red-400 dark:bg-red-900/20 dark:text-red-400'}`}>
        {hasPong ? 'PONG' : 'PONG?'}
      </span>
    </RowWrapper>
  );
});

// ── Other row ─────────────────────────────────────────────────────────────────

interface OtherProps {
  row: OtherRow;
  isActive: boolean;
  onFocus: (segmentId: string | undefined) => void;
  rowRef?: React.Ref<HTMLDivElement>;
}

export const OtherRowView = memo(function OtherRowView({
  row,
  isActive,
  onFocus,
  rowRef,
}: OtherProps) {
  const summary = JSON.stringify(row.event.payload).slice(0, 60);
  return (
    <RowWrapper isActive={isActive} onClick={() => onFocus(undefined)} rowRef={rowRef}>
      <span className="w-5 shrink-0 text-right font-mono text-zinc-300 dark:text-zinc-600">
        {row.event.seq >= 0 ? row.event.seq : ''}
      </span>
      <TypeBadge type={row.event.type} />
      <span className="truncate text-zinc-500 dark:text-zinc-400">{summary}</span>
    </RowWrapper>
  );
});
