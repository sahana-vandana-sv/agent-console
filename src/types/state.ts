export type ConnectionPhase =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'STREAMING'
  | 'BUFFERING'
  | 'TOOL_PENDING'
  | 'RECONNECTING'
  | 'RESUMING'
  | 'STREAM_END';

export interface TextSegment {
  type: 'text';
  id: string;         // `text-${seqStart}`
  content: string;
  seqStart: number;
  seqEnd: number;
}

export interface ToolSegment {
  type: 'tool';
  id: string;         // callId
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'resolved';
  result?: Record<string, unknown>;
}

export type Segment = TextSegment | ToolSegment;

export interface ContextSnapshot {
  seq: number;
  data: Record<string, unknown>;
}

export interface TraceEvent {
  id: string;
  type: string;
  seq: number;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface StreamState {
  phase: ConnectionPhase;
  segments: Segment[];
  contextSnapshots: Map<string, ContextSnapshot[]>;
  traceEvents: TraceEvent[];
  lastProcessedSeq: number;
  error: string | null;
  reconnectAttempt: number;
}

export type AgentAction =
  | { type: 'USER_MESSAGE_SENT' }
  | { type: 'WS_OPEN' }
  | { type: 'WS_CLOSE' }
  | { type: 'TOKENS_BATCH'; tokens: Array<{ seq: number; text: string }>; streamId: string }
  | { type: 'TOOL_CALL'; seq: number; callId: string; toolName: string; args: Record<string, unknown>; streamId: string }
  | { type: 'TOOL_RESULT'; callId: string; result: Record<string, unknown> }
  | { type: 'CONTEXT_SNAPSHOT'; seq: number; contextId: string; data: Record<string, unknown> }
  | { type: 'STREAM_END'; streamId: string }
  | { type: 'SEQ_GAP_DETECTED' }
  | { type: 'SEQ_GAP_FILLED' }
  | { type: 'RECONNECT_SUCCESS' }
  | { type: 'REPLAY_COMPLETE' }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PING_RECEIVED'; seq: number; challenge: string }
  | { type: 'PONG_SENT'; echo: string };
