@AGENTS.md

# CLAUDE.md — Agent Console

## What This Project Is

A real-time **Agent Console** built in Next.js 14 (App Router). It connects to a mock AI agent backend over WebSocket, renders streaming token responses with mid-stream tool call interruptions, displays a live protocol trace timeline, and survives deliberate chaos (dropped connections, out-of-order messages, duplicate events, corrupt heartbeats).
This is a **distributed systems problem with a render loop attached** — not a chat UI exercise.

---

## Backend

```bash
docker build -t agent-server ./agent-server
docker run -p 4747:4747 agent-server              # normal mode
docker run -p 4747:4747 agent-server --mode chaos  # chaos mode
```

Endpoints:

- `ws://localhost:4747/ws` — WebSocket
- `GET /health` — server status + current seq
- `GET /log` — every client event the server recorded. Check for `"violation"` entries. This is the evaluator's verification tool.
- `GET /reset` — clear session state between test runs

---

## Trigger Keywords → Scripts (deterministic)

| Keyword                          | Script         | What it exercises                                                      |
| -------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `hello` / `hi`                   | greeting       | Tokens only, no tool calls. Start here.                                |
| `report` / `q3`                  | report_summary | 1 tool call mid-stream + 2 CONTEXT_SNAPSHOTs (same ctx_id = diff case) |
| `analyze` / `compare`            | multi_tool     | 2 sequential tool calls, no CONTEXT updates between them               |
| `lookup` / `find` / `search`     | lookup         | TOOL_CALL fires **before any tokens** — critical edge case             |
| `large` / `schema` / `database`  | large_context  | ~550KB CONTEXT_SNAPSHOT + tool call + second snapshot with extra keys  |
| `long` / `document` / `detailed` | long_response  | ~60 tokens + 1 tool call                                               |
| _(anything else)_                | default        | 1 tool call mid-stream, moderate length                                |

---

## Protocol

Every server message: `{ type, seq, ...fields }`. Seq is monotonically increasing **per conversation turn** — it resets to 0 on every new USER_MESSAGE.

### Server → Client

| Type               | Key fields                                                   |
| ------------------ | ------------------------------------------------------------ |
| `TOKEN`            | `seq`, `text`, `stream_id`                                   |
| `TOOL_CALL`        | `seq`, `call_id`, `tool_name`, `args`, `stream_id`           |
| `TOOL_RESULT`      | `seq`, `call_id`, `result`, `stream_id`                      |
| `CONTEXT_SNAPSHOT` | `seq`, `context_id`, `data`                                  |
| `PING`             | `seq`, `challenge` (empty string `""` in chaos corrupt mode) |
| `STREAM_END`       | `seq`, `stream_id`                                           |
| `ERROR`            | `seq`, `code`, `message`                                     |

### Client → Server

| Type           | Fields                        | Timing                                                     |
| -------------- | ----------------------------- | ---------------------------------------------------------- |
| `USER_MESSAGE` | `content`                     | On user submit                                             |
| `PONG`         | `echo` (= challenge verbatim) | Within 3s of PING                                          |
| `TOOL_ACK`     | `call_id`                     | Within 2s of TOOL_CALL                                     |
| `RESUME`       | `last_seq`                    | **First message after reconnection, before anything else** |

### Sequence number rules

1. `seq` resets to 0 on every new USER_MESSAGE (server resets history per turn).
2. Track `lastProcessedSeq` = highest seq **rendered to DOM** (not just received).
3. `lastProcessedSeq` must also reset to 0 when user sends a new message.
4. On reconnection, send `RESUME { last_seq: lastProcessedSeq }` as the very first message.
5. In chaos mode: buffer out-of-order messages, flush contiguous runs, deduplicate by seq.
6. Three missed PONGs = server terminates connection (checked every 12 seconds).
7. Heartbeat starts 2 seconds after connection opens — PING won't arrive immediately.

### Critical: stream does NOT resume after reconnect

## The server replays events from history but does NOT continue executing the script. After a drop mid-stream, the replayed events are all the client gets. STREAM_END may never arrive. Handle gracefully — don't wait forever for STREAM_END.

## Chaos Engine Internals (from chaos.ts)

Understanding exactly how chaos works lets you write a correct buffer.

### Per-connection chaos config (randomly generated)

| Parameter                 | Range                                           |
| ------------------------- | ----------------------------------------------- |
| `dropAfterMessages`       | 15–45 messages, or null (50% chance of no drop) |
| `reorderProbability`      | 15–35% per message                              |
| `duplicateProbability`    | 5–15% per message                               |
| `latencySpikeProbability` | 5–13% per message                               |
| `latencySpikeMs`          | 2000–8000ms                                     |
| `corruptPingProbability`  | 15–25% per PING                                 |

### How reordering works (Fisher-Yates, buffer size = 4)

- Each message has a 15–35% chance of being held in a buffer (max 4 messages).
- When the buffer reaches 4 messages, all 4 are Fisher-Yates shuffled and sent together.
- When a message is NOT buffered, the existing buffer + this message are all shuffled and flushed.
- At stream end, any remaining buffered messages are shuffled and flushed.
  **Implication for your seq buffer:** gaps are at most 4 messages wide. Your buffer gap timeout (recommended: 2000ms) must account for the latency spike range (up to 8s). Use 3000ms as a safe timeout.

### How duplicates work

Duplicates are **exact copies** — same `seq`, same content. They appear immediately after the original in the output. Your `Set<number>` dedup handles this correctly.

### How connection drops work

The server calls `ws.terminate()` (hard kill, no close frame) after `dropAfterMessages` messages. Your client must handle `ws.onerror` as well as `ws.onclose` — a hard terminate fires `onerror` before `onclose`.

### Corrupt PING

## Challenge is set to `""` (empty string). Guard: `if (!msg.challenge) { /* send PONG with echo: "" anyway, don't crash */ }`. The server still expects a PONG — send `{ type: "PONG", echo: "" }`.

## Context Diff Cases (from scripts.ts)

The context inspector needs to handle these exact diff scenarios:
**report_summary script** — `ctx_report` gets two snapshots:

- Snapshot 1: `{ report, pages, sections, last_updated, source, access_level }`
- Snapshot 2: adds `current_focus: "operations"` and `extracted_metrics: { revenue_yoy, operating_margin, prev_operating_margin }`
- Diff: 2 keys added, 0 removed, 0 changed.
  **large_context script** — `ctx_schema` gets two snapshots:
- Snapshot 1: full 550KB schema object
- Snapshot 2: same object + `analysis_complete: true` + `flagged_issues: [...]`
- Diff: 2 keys added at the top level. Virtualised tree is essential — do not eagerly expand all 64 tables.
  **lookup script** — `ctx_search` appears after the tool call, not before tokens. Only one snapshot, no diff needed.

---

## Architecture

### Three-layer separation (strict — never cross these boundaries)

```
WebSocket (class, lives in useRef)
    ↓ raw messages
Protocol Layer (AgentProtocol class — no React imports)
  - seq ordering buffer (gap detection + timeout flush)
  - deduplication Set<number>
  - PING/PONG handler (responds even to empty challenge)
  - TOOL_ACK timer (fires within 2s)
  - reconnect + exponential backoff
  - token batching (~16ms accumulation before dispatch)
    ↓ clean, ordered, deduplicated, batched actions
useReducer (React)
  - phase transitions
  - segment list
  - context snapshot history
    ↓ render state only
React components (read-only render, no protocol logic)
```

### State split

| What                             | Where                                   | Why                         |
| -------------------------------- | --------------------------------------- | --------------------------- |
| WebSocket instance               | `useRef`                                | Must not trigger re-renders |
| `lastProcessedSeq`               | `useRef`                                | Operational, not visual     |
| Out-of-order buffer              | `useRef` — `Map<number, ServerMessage>` | Operational                 |
| Processed seqs                   | `useRef` — `Set<number>`                | Operational                 |
| Stream phase                     | `useReducer`                            | Drives render               |
| Segment list                     | `useReducer`                            | Drives render               |
| Context snapshot history         | `useReducer`                            | Drives render               |
| Panel open/closed, filter values | `useState`                              | UI only                     |

---

## WebSocket State Machine

```
IDLE
  │ USER_MESSAGE_SENT → reset lastProcessedSeq to 0
  ▼
CONNECTING
  │ ws.onopen
  ▼
CONNECTED
  │ TOKEN / CONTEXT_SNAPSHOT (first event)
  ▼
STREAMING ◄────────────────────────────────────────────────┐
  │                                                         │
  │ TOOL_CALL                                    TOOL_RESULT│
  ▼                                                         │
TOOL_PENDING ─────────────────────────────────────────────►┘
  │
  │ STREAM_END (or: reconnect replay exhausted)
  ▼
STREAM_END → reset → IDLE
Any state except IDLE:
  │ ws.onclose or ws.onerror (hard terminate fires onerror first)
  ▼
RECONNECTING
  backoff: 500ms → 1s → 2s → 4s → 10s (cap)
  chat panel stays interactive during this phase
  tool cards stay visible with "waiting" status
  │ ws.onopen
  ▼
RESUMING
  send RESUME as FIRST message (before anything else)
  replay events → deduplicate → stitch into existing segment list
  │ replay complete
  ▼
STREAMING (existing segments preserved, replay stitched in)
Chaos only (runs in parallel with STREAMING):
BUFFERING — seq gap detected → hold messages in Map → flush when contiguous
            gap timeout: 3000ms → flush anyway, accept gap
PING/PONG — handled entirely in AgentProtocol class, never reaches reducer.
            Fires from any state. Respond to corrupt PING (empty challenge) without crashing.
```

---

## Segment Model

The stream is NOT a flat string. State is a **typed list of segments**:

```typescript
type TextSegment = {
  type: "text";
  id: string; // stable React key: `text-${seqStart}`
  content: string;
  seqStart: number;
  seqEnd: number;
};
type ToolSegment = {
  type: "tool";
  id: string; // stable React key: callId
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "resolved";
  result?: Record<string, unknown>;
};
type Segment = TextSegment | ToolSegment;
type StreamState = {
  phase: ConnectionPhase;
  segments: Segment[];
  lastProcessedSeq: number;
  activeStreamId: string | null;
  contextSnapshots: Map<string, ContextSnapshot[]>; // context_id → history
};
```

Rules:

- `TOOL_CALL` → push new `ToolSegment`, freeze current `TextSegment`
- Tokens after `TOOL_RESULT` → push a **new** `TextSegment` (never append to pre-tool text)
- Multiple tool calls → multiple `ToolSegment` entries, never overwrite
- `lookup` script: TOOL_CALL arrives before any TextSegment exists — handle gracefully
- React keys must be stable — use `callId` for tool, `seqStart` for text

---

## TypeScript

- `"strict": true` in tsconfig — no exceptions
- No `any` outside `src/lib/escape-hatch.ts` (document every use)
- No `@ts-ignore`
- Copy server's `src/types.ts` into `src/types/protocol.ts` — canonical types, don't rewrite

```typescript
type ConnectionPhase =
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "STREAMING"
  | "BUFFERING"
  | "TOOL_PENDING"
  | "RECONNECTING"
  | "RESUMING"
  | "STREAM_END";
type AgentAction =
  | { type: "USER_MESSAGE_SENT" }
  | { type: "WS_OPEN" }
  | { type: "WS_CLOSE" }
  | {
      type: "TOKENS_BATCH";
      tokens: Array<{ seq: number; text: string }>;
      streamId: string;
    }
  | {
      type: "TOOL_CALL";
      seq: number;
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      streamId: string;
    }
  | { type: "TOOL_RESULT"; callId: string; result: Record<string, unknown> }
  | {
      type: "CONTEXT_SNAPSHOT";
      seq: number;
      contextId: string;
      data: Record<string, unknown>;
    }
  | { type: "STREAM_END"; streamId: string }
  | { type: "SEQ_GAP_DETECTED" }
  | { type: "SEQ_GAP_FILLED" }
  | { type: "RECONNECT_SUCCESS" }
  | { type: "REPLAY_COMPLETE" }
  | { type: "ERROR"; code: string; message: string };
```

## Note: `TOKENS_BATCH` not `TOKEN` — the protocol class batches ~16ms of tokens before dispatch. This keeps React render rate under control at 30+ tokens/sec.

## Components

### StreamingChat

- Renders the `segments` array
- `TextSegment` → `<TextChunk>` with stable key `text-${seqStart}`
- `ToolSegment` → `<ToolCard>` with stable key `callId`, shows pending spinner or result
- No layout shift: `min-height` on message container, tool card uses fixed height
- `lookup` edge case: first rendered element may be a `ToolCard`, not text

### TraceTimeline (collapsible side panel)

- **Virtualised list** — never re-render full list on every token
- Consecutive TOKEN events → single grouped row "Streamed N tokens (Xs)" with expand
- TOOL_CALL and TOOL_RESULT rows visually linked by `call_id` (indent or connector line)
- Filter bar: by event type, by content search
- Bidirectional highlight: timeline row ↔ chat segment

### ContextInspector (collapsible side panel)

- Syntax-highlighted JSON tree, **lazily expanded** (never auto-expand all nodes)
- On new snapshot with same `context_id`: compute structural diff and highlight
- For 550KB payloads: virtualised tree, top-level keys only on load
- History scrubber: step through snapshot sequence, show diff at each step

### ConnectionStatus (non-blocking)

- Appears within 500ms of drop
- Shows backoff countdown
- Chat remains interactive (scroll, copy) during reconnect

---

## File Structure

```
src/
  app/
    page.tsx
  components/
    StreamingChat/
      index.tsx
      TextChunk.tsx
      ToolCard.tsx
    TraceTimeline/
      index.tsx
      TimelineRow.tsx
      FilterBar.tsx
    ContextInspector/
      index.tsx
      JsonTree.tsx
      DiffView.tsx
      HistoryScrubber.tsx
    ConnectionStatus.tsx
  lib/
    AgentProtocol.ts     # WebSocket class — zero React imports
    seqBuffer.ts         # ordering + dedup — pure functions, unit tested
    jsonDiff.ts          # structural JSON diff — pure functions, unit tested
    escape-hatch.ts      # ONLY place `any` is permitted, documented
  hooks/
    useAgentReducer.ts   # useReducer + all action/state types
    useWebSocket.ts      # mounts AgentProtocol, dispatches to reducer
  types/
    protocol.ts          # copied from agent-server/src/types.ts
    state.ts             # Segment, StreamState, ConnectionPhase
```

---

## Testing Targets

```
seqBuffer.ts:
  - empty buffer returns nothing
  - single element flushes immediately when contiguous
  - fully reversed sequence [4,3,2,1] flushes in order [1,2,3,4]
  - duplicate seq is dropped
  - gap timeout flushes partial buffer after 3000ms
  - buffer of exactly 4 flushes correctly
jsonDiff.ts:
  - key added at top level
  - key removed at top level
  - nested value changed
  - key added + key removed in same diff
  - array replaced with different array
  - 550KB object diffs in < 100ms
AgentProtocol.ts:
  - PONG sent within 2s of PING
  - PONG echoes challenge verbatim
  - empty challenge PING → PONG with echo: "" (no crash)
  - TOOL_ACK sent within 2s of TOOL_CALL
  - RESUME is first message after reconnect
  - lastProcessedSeq resets on USER_MESSAGE_SENT
```

---

## Build & Run

```bash
npm install
npm run build
npm run start
# app: http://localhost:3000
# agent server must be on ws://localhost:4747/ws
```

## No env vars required. WebSocket URL defaults to `ws://localhost:4747/ws`.

## Known Protocol Race Condition (document in DECISIONS.md)

## The TOOL_ACK timeout creates a race: if the connection drops after TOOL_CALL but before the client sends TOOL_ACK, and reconnection + replay delivers TOOL_RESULT before the client can send TOOL_ACK for the replayed TOOL_CALL, the server logs a violation even though the client behaved correctly. This is a protocol design gap — the server does not distinguish between "ACK never sent" and "ACK sent but connection dropped before it arrived." Document this in DECISIONS.md. It will impress the reviewers.

## Evaluation Checklist

- [ ] `curl http://localhost:4747/log` shows no `"violation"` entries in normal mode
- [ ] PONG sent within 3s of every PING (target: under 1s)
- [ ] TOOL_ACK sent within 2s of every TOOL_CALL
- [ ] RESUME is the first message sent after reconnection
- [ ] `lastProcessedSeq` resets to 0 on new USER_MESSAGE
- [ ] Duplicate seqs not rendered twice
- [ ] Empty challenge PING does not crash the app
- [ ] Tool cards remain visible with "waiting" state during reconnect
- [ ] Token text not duplicated after replay
- [ ] 550KB context snapshot does not freeze the tab
- [ ] `lookup` script (tool before tokens) renders correctly
- [ ] Two sequential tool calls render as stacked cards, not overwritten
- [ ] Screen recording covers all 5 chaos scenarios (mandatory)
