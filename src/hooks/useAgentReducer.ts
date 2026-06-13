import { useReducer } from 'react';
import type {
  StreamState,
  AgentAction,
  Segment,
  TextSegment,
  ToolSegment,
  ContextSnapshot,
  TraceEvent,
} from '../types/state';

// ─── Initial state ──────────────────────────────────────────────────────────

function makeInitialState(): StreamState {
  return {
    phase: 'IDLE',
    segments: [],
    contextSnapshots: new Map(),
    traceEvents: [],
    lastProcessedSeq: 0,
    error: null,
    reconnectAttempt: 0,
  };
}

// ─── Segment helpers ────────────────────────────────────────────────────────

/** The last segment in the list, or undefined. */
function lastSeg(segments: Segment[]): Segment | undefined {
  return segments[segments.length - 1];
}

/**
 * Append tokens to the current text run.
 *
 * Rules:
 *  - If the last segment is a text segment → append in-place (return new array
 *    with updated last element — immutable update).
 *  - Otherwise (no segments yet, or last is a ToolSegment) → push a new
 *    TextSegment. This handles the "tokens after TOOL_RESULT" and the
 *    "lookup: TOOL_CALL before any token" cases.
 */
function applyTokensBatch(
  segments: Segment[],
  tokens: Array<{ seq: number; text: string }>,
): Segment[] {
  if (tokens.length === 0) return segments;

  const text = tokens.map((t) => t.text).join('');
  const minSeq = tokens[0].seq;
  const maxSeq = tokens[tokens.length - 1].seq;

  const last = lastSeg(segments);

  if (last?.type === 'text') {
    // Append to existing text segment
    const updated: TextSegment = {
      ...last,
      content: last.content + text,
      seqEnd: maxSeq,
    };
    return [...segments.slice(0, -1), updated];
  }

  // Push a fresh text segment
  const fresh: TextSegment = {
    type: 'text',
    id: `text-${minSeq}`,
    content: text,
    seqStart: minSeq,
    seqEnd: maxSeq,
  };
  return [...segments, fresh];
}

// ─── Reducer ────────────────────────────────────────────────────────────────

function streamReducer(state: StreamState, action: AgentAction): StreamState {
  // 🔄 REDUCER: every action that reaches React is logged here
  if (action.type === 'TOKENS_BATCH') {
    console.log(
      '%c🔄 REDUCER action', 'color:#a78bfa;font-weight:bold',
      `TOKENS_BATCH — ${action.tokens.length} token(s): "${action.tokens.map(t=>t.text).join('')}"`,
      `| phase: ${state.phase} | segments: ${state.segments.length}`
    );
  } else {
    console.log(
      '%c🔄 REDUCER action', 'color:#a78bfa;font-weight:bold',
      action.type,
      `| phase: ${state.phase} → ?`,
      action
    );
  }

  switch (action.type) {

    // ── User sends a new message — full reset ──────────────────────────────
    case 'USER_MESSAGE_SENT':
      return makeInitialState();

    // ── WebSocket opened (initial connection) ──────────────────────────────
    case 'WS_OPEN':
      return { ...state, phase: 'CONNECTING', error: null };

    // ── WebSocket closed / dropped ─────────────────────────────────────────
    case 'WS_CLOSE':
      return {
        ...state,
        phase: 'RECONNECTING',
        reconnectAttempt: state.reconnectAttempt + 1,
      };

    // ── Reconnect succeeded; about to send RESUME ──────────────────────────
    case 'RECONNECT_SUCCESS':
      return { ...state, phase: 'RESUMING' };

    // ── Replay complete after RESUME ───────────────────────────────────────
    case 'REPLAY_COMPLETE':
      return { ...state, phase: 'STREAMING' };

    // ── Seq gap detected (chaos buffering) ────────────────────────────────
    case 'SEQ_GAP_DETECTED':
      return { ...state, phase: 'BUFFERING' };

    case 'SEQ_GAP_FILLED':
      return {
        ...state,
        phase: state.phase === 'BUFFERING' ? 'STREAMING' : state.phase,
      };

    // ── Token batch arrived ────────────────────────────────────────────────
    case 'TOKENS_BATCH': {
      const segments = applyTokensBatch(state.segments, action.tokens);
      const maxSeq = action.tokens[action.tokens.length - 1]?.seq ?? state.lastProcessedSeq;
      // Capture the text segment id so the timeline can highlight the chat element
      const lastSeg = segments[segments.length - 1];
      const segmentId = lastSeg?.type === 'text' ? lastSeg.id : undefined;
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'TOKEN',
        seq: maxSeq,
        payload: { count: action.tokens.length, streamId: action.streamId, segmentId },
      });
      const nextPhase = state.phase === 'CONNECTED' || state.phase === 'RESUMING'
        ? 'STREAMING'
        : state.phase === 'TOOL_PENDING'
          ? state.phase   // tool card still open — don't change phase
          : 'STREAMING';
      // 📝 SEGMENT UPDATE: shows content growing in the active TextSegment
      const activeText = lastSeg?.type === 'text' ? lastSeg.content : '(no text seg)';
      console.log(
        '%c📝 TEXT SEGMENT now:', 'color:#34d399;font-weight:bold',
        `"${activeText.slice(-60)}"`,
        `| total chars: ${activeText.length} | segments: ${segments.length}`
      );
      return {
        ...state,
        phase: nextPhase,
        segments,
        traceEvents,
        lastProcessedSeq: Math.max(state.lastProcessedSeq, maxSeq),
      };
    }

    // ── Tool call arrived — freeze current text segment ───────────────────
    case 'TOOL_CALL': {
      console.log('%c🔧 REDUCER: TOOL_CALL', 'color:#f59e0b;font-weight:bold',
        `→ phase: TOOL_PENDING | pushing ToolSegment id=${action.callId} tool=${action.toolName}`);
      const toolSeg: ToolSegment = {
        type: 'tool',
        id: action.callId,
        callId: action.callId,
        toolName: action.toolName,
        args: action.args,
        status: 'pending',
      };
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'TOOL_CALL',
        seq: action.seq,
        payload: { callId: action.callId, toolName: action.toolName, args: action.args },
      });
      return {
        ...state,
        phase: 'TOOL_PENDING',
        segments: [...state.segments, toolSeg],
        traceEvents,
        lastProcessedSeq: Math.max(state.lastProcessedSeq, action.seq),
      };
    }

    // ── Tool result arrived — resolve the card, ready for more tokens ──────
    case 'TOOL_RESULT': {
      console.log('%c✅ REDUCER: TOOL_RESULT', 'color:#22c55e;font-weight:bold',
        `call_id=${action.callId} — ToolCard status: pending→resolved`);
      const segments = state.segments.map((seg): Segment => {
        if (seg.type === 'tool' && seg.callId === action.callId) {
          return { ...seg, status: 'resolved', result: action.result };
        }
        return seg;
      });
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'TOOL_RESULT',
        seq: -1,
        payload: { callId: action.callId },
      });
      // Only transition to STREAMING when ALL tool cards are resolved.
      // Chaos can fire two TOOL_CALLs before any TOOL_RESULT arrives — in that
      // case we must stay in TOOL_PENDING until both results are received.
      const stillPending = segments.some(
        (seg) => seg.type === 'tool' && (seg as ToolSegment).status === 'pending',
      );
      return {
        ...state,
        phase: stillPending ? 'TOOL_PENDING' : 'STREAMING',
        segments,
        traceEvents,
      };
    }

    // ── Context snapshot ───────────────────────────────────────────────────
    case 'CONTEXT_SNAPSHOT': {
      const history = state.contextSnapshots.get(action.contextId) ?? [];
      const snapshot: ContextSnapshot = { seq: action.seq, data: action.data };
      const updated = new Map(state.contextSnapshots);
      updated.set(action.contextId, [...history, snapshot]);
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'CONTEXT_SNAPSHOT',
        seq: action.seq,
        payload: { contextId: action.contextId },
      });
      return {
        ...state,
        contextSnapshots: updated,
        traceEvents,
        lastProcessedSeq: Math.max(state.lastProcessedSeq, action.seq),
      };
    }

    // ── Stream ended cleanly ───────────────────────────────────────────────
    case 'STREAM_END': {
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'STREAM_END',
        seq: -1,
        payload: { streamId: action.streamId },
      });
      return { ...state, phase: 'STREAM_END', traceEvents };
    }

    // ── Server error ───────────────────────────────────────────────────────
    case 'ERROR': {
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'ERROR',
        seq: -1,
        payload: { code: action.code, message: action.message },
      });
      return { ...state, error: `${action.code}: ${action.message}`, traceEvents };
    }

    // ── PING / PONG — protocol heartbeat trace ─────────────────────────────
    case 'PING_RECEIVED': {
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'PING',
        seq: action.seq,
        payload: { challenge: action.challenge || '(empty — corrupt ping)' },
      });
      return { ...state, traceEvents };
    }

    case 'PONG_SENT': {
      const traceEvents = addTraceEvent(state.traceEvents, {
        type: 'PONG',
        seq: -1,
        payload: { echo: action.echo || '(empty)' },
      });
      return { ...state, traceEvents };
    }

    default:
      return state;
  }
}

// ─── Trace helper ────────────────────────────────────────────────────────────

let traceIdCounter = 0;

function addTraceEvent(
  events: TraceEvent[],
  partial: Omit<TraceEvent, 'id' | 'timestamp'>,
): TraceEvent[] {
  const ev: TraceEvent = {
    ...partial,
    id: `ev-${++traceIdCounter}`,
    timestamp: Date.now(),
  };
  // Keep at most 1000 events in state to avoid unbounded growth
  const trimmed = events.length >= 1000 ? events.slice(-999) : events;
  return [...trimmed, ev];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAgentReducer() {
  return useReducer(streamReducer, undefined, makeInitialState);
}
