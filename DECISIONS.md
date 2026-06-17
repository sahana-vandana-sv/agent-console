# DECISIONS.md — Agent Console

## Architecture Decisions

### 1. useReducer over Redux / Zustand
Native `useReducer` with typed `StreamState`. Zero dependencies, single-direction state flow. Redux adds boilerplate for no benefit at this scale; Zustand is a reasonable alternative but a runtime dependency for marginal ergonomic gain. Tradeoff: no Redux DevTools — acceptable because the TraceTimeline panel provides equivalent protocol observability.

### 2. Phase state labelling
`USER_MESSAGE_SENT` transitions to `CONNECTING` (not `IDLE`) since the WebSocket connect is initiated synchronously. `WS_OPEN` transitions to `CONNECTED` (not `CONNECTING`) since the socket is open. This keeps phase names accurate and lets the UI distinguish "idle, waiting for user" (`CONNECTED`) from "message sent, waiting for first token" (`CONNECTING`). `REPLAY_COMPLETE` was removed — it was defined but never dispatched; replay termination is handled by `STREAM_END` or the idle timer.

### 3. Seq-based ordering and deduplication
Two structures in `seqBuffer.ts`: a `Map<number, ServerMessage>` (ordering buffer, O(1) insert/lookup by seq) and a `Set<number>` (dedup guard, persists across drains to catch late duplicates after the original has already been removed from the Map). `nextExpected` is a plain integer starting at 1 (server uses `++seq`). The Map drains contiguous runs without sorting. The Set survives drain, catching duplicates that arrive after dispatch.

Three bypass rules: `TOOL_CALL` bypasses ordering (still deduped) so `TOOL_ACK` goes out within the 2s window without the 3s gap-timer overhead. `STREAM_END`, `PING`, `ERROR` bypass both — `STREAM_END` especially because its seq is already in `seen` from the original connection and would be silently dropped during replay otherwise.

`trimAfter(lastRendered)` on reconnect evicts seqs `> lastRendered` from `seen` and `buffer`, resets `nextExpected = lastRendered + 1`. Handles the rAF-batch race: messages received but not yet committed to the reducer must be re-delivered by replay.

### 4. Layout shift prevention during tool call interruptions
Append-only segment model: `TOOL_CALL` appends a new `ToolSegment`; the preceding `TextSegment` stays mounted with its committed height. Stable React keys (`text-${seqStart}` for text, `callId` for tool) mean React reuses DOM nodes — no unmount/remount. Fixed `min-h` on tool cards prevents height change on `TOOL_RESULT`. `memo` on `TextChunk` blocks re-rendering frozen segments during subsequent token batches.

### 5. Reconnection state recovery — DOM-consumed vs socket-received
`lastProcessedSeqRef` is written **in the render body** (not `useEffect`): `lastProcessedSeqRef.current = state.lastProcessedSeq`. This advances only after React commits a state update — not on WebSocket receipt, not on seqBuffer dedup, not mid-rAF. It is DOM truth. On reconnect: `seqBuf.trimAfter(lastProcessedSeqRef.current)` then `RESUME { last_seq: lastProcessedSeqRef.current }`. The server replays exactly what the DOM missed. Without the ref-in-render-body pattern, a drop mid-token-batch would send a `last_seq` too high and silently lose those tokens forever.

---

## Known Limitations

**TOOL_ACK timeout under chaos latency spike — structurally unwinnable.** The chaos engine injects 2000–8000ms latency spikes. The server's ACK window is 2s measured from when it *sends* the TOOL_CALL. A minimum spike (2000ms) exactly consumes the entire budget. The seq-buffer bypass removed the only controllable delay; what remains is injected network latency the client cannot anticipate. Clean in normal mode — `/log` shows no violations there.

**PING/PONG missed heartbeat under chaos — structurally unwinnable.** The server's PONG window is 3s from send. A latency spike ≥ 3s means the client receives the PING after the window expires. The PONG arrives too late. Three missed PONGs trigger `ws.terminate()`, handled as a normal drop (reconnect → RESUME, no content lost). Clean in normal mode.

**TOOL_ACK race on reconnect — protocol design gap.** If the connection drops after `TOOL_CALL` but before the client sends `TOOL_ACK`, and replay delivers `TOOL_RESULT` before the client can re-ACK, the server logs a violation even though the client behaved correctly. The server cannot distinguish "ACK never sent" from "ACK sent but connection dropped before arrival." Not fixable client-side.

**Partial stream after chaos drop — by design.** The server replays history but does not resume script execution. A mid-response drop yields a partial answer. The client ends the stream cleanly via the 3s idle timer. Surfaced clearly in the UI; not a client bug.

---

## Scaling Considerations

### 50 concurrent agent streams (operations dashboard)
Replace `useAgentReducer` with a `StreamRegistry` (`Map<streamId, StreamState>`) outside React. Components subscribe per-stream — a token on stream A never re-renders stream B. One global rAF loop drains all per-stream token queues per animation frame, bounding React render rate to 60fps. Multiplex streams over a bounded WebSocket pool (N = core count) rather than 50 independent connections. Virtualise the dashboard grid — unmount off-screen cards, preserve state in the registry. Offload `seqBuffer` reordering and `jsonDiff` to a Web Worker at this volume.

### 100x longer responses (full document generation)
Chunked text segments: freeze segments at ~2000 chars, only the live tail appends. `memo` makes all prior chunks static — O(1) re-render cost per token regardless of document length. Move trace events out of React state into a `useRef` circular buffer; sync only a windowed slice into render state when the timeline is open. Store `TextSegment.content` as an external buffer reference rather than a JS string that gets copied on every immutable state update.
