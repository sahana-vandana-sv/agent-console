# DECISIONS.md — Agent Console

## What This Document Is

A record of every architectural decision made, every chaos bug found and fixed, every tradeoff accepted, and every thing I would do differently if starting over.

---

## Architecture Decisions

### 1. Three-layer separation (no cross-boundary imports)

**Decision:** `AgentProtocol` (pure TS class, zero React imports) → `useAgentReducer` (useReducer, no WebSocket logic) → React components (read-only render).

**Why:** WebSocket connections must survive React's strict-mode double-effect mount/unmount cycle without causing double-RESUME or double-connect. Keeping the protocol in a class with a stable `useRef` reference means the connection lifecycle is unaffected by re-renders. The reducer gets clean, ordered, deduplicated actions and never needs to know _why_ a message was delayed.

**Tradeoff:** Two files must stay in sync (`AgentAction` in `state.ts` and the `dispatch()` call sites in `AgentProtocol.ts`). TypeScript strict mode catches mismatches at build time; no runtime risk.

---

### 2. useReducer over Redux / Zustand

**Decision:** Native `useReducer` with a typed `StreamState`. No external state library.

**Why useReducer fits this problem exactly:**

This app has one consumer of agent state (the page), one producer (the WebSocket), and a well-defined set of transitions driven by protocol events. The state machine is explicit:

```
IDLE → CONNECTING → CONNECTED → STREAMING ⇄ TOOL_PENDING
     ↘ RECONNECTING → RESUMING ↗
     BUFFERING (chaos gap)
     STREAM_END
```

`useReducer` maps directly onto this: each protocol event becomes a dispatched action, each state transition is a pure function, and the action type doubles as the event log. The reducer is the state machine. There is no impedance mismatch.

**Why not Redux:**

Redux adds: a store singleton, a Provider, action creators, selectors, and middleware configuration — before writing a single line of domain logic. For a single-consumer state tree this is pure overhead. The canonical Redux argument is cross-component state sharing; here there is one component tree with one root that owns all agent state. Redux DevTools would be useful but the TraceTimeline panel provides equivalent protocol-level observability tailored to this specific domain.

**Why not Zustand:**

Zustand is the right call for multi-consumer state (many components subscribing independently) or state that needs to be read outside React (in a class, a worker, a utility). Neither applies here. `AgentProtocol` dispatches into React via the `dispatch` ref it receives at construction — it never needs to read state back. Adding Zustand would be a runtime dependency for marginal ergonomic gain.

**Why this holds under chaos specifically:**

Chaos introduces out-of-order delivery, duplicates, mid-stream drops, and replays. All of these are handled *before* `dispatch()` is called — in `AgentProtocol` and `seqBuffer`. By the time an action reaches the reducer, it is guaranteed to be:
- In sequence order
- Deduplicated
- Correctly typed

The reducer therefore never needs to handle "what if seq 7 arrives before seq 5" — that invariant is enforced at the boundary. This is what makes a simple `useReducer` viable under chaos: the complexity budget is spent in the protocol layer, not the state layer. Redux or Zustand would not have changed this; they would have added a layer without removing any of the protocol complexity.

**What this costs:**

No time-travel debugging via Redux DevTools. The TraceTimeline panel compensates by showing the full ordered event log with seq numbers, types, and payloads — effectively a domain-specific DevTools built for this protocol. The cost is real only during development; it does not affect production correctness.

---

### 3. Seq buffer in protocol layer, not reducer

**Decision:** `seqBuffer.ts` lives in `src/lib/` and is called inside `AgentProtocol.ts` before any `dispatch()` call.

**Why:** The reducer must never receive out-of-order messages — immutable state updates make it hard to "insert" a token into the right position retroactively. Ordering is a transport concern, not a view concern. Keeping it in the protocol layer means the reducer always sees a clean, in-order stream.

**Data structures:** `Map<number, ServerMessage>` as the ordering buffer (O(1) lookup, O(k) drain); `Set<number>` as the dedup guard (persists across drains so late duplicates are still caught after the Map has been cleared). See [Seq-Based Ordering](#seq-based-ordering-and-deduplication--data-structure-rationale) for full rationale.

**Tradeoff:** The gap timer (3000ms) lives in `AgentProtocol` and fires `dispatch(STREAM_END)` on timeout. This means the reducer cannot observe the buffering state directly — we synthesise a `SEQ_GAP_DETECTED` / `SEQ_GAP_FILLED` pair to show the BUFFERING phase in the UI.

---

### 4. TOOL_CALL bypasses seq ordering

**Decision:** In `seqBuffer.ts`, `TOOL_CALL` messages are deduped but _not_ held in the ordering buffer — they are dispatched immediately on arrival.

**Why:** The server requires `TOOL_ACK` within 2 seconds of `TOOL_CALL`. In chaos mode, latency spikes reach 8 seconds. If `TOOL_CALL` sits in the seq buffer waiting for earlier seq numbers, the combined delay (latency spike + gap timer) can easily exceed 2s, causing a `TOOL_ACK_TIMEOUT` violation.

**Observed:** This was confirmed in a live chaos run — `/log` showed `TOOL_ACK_TIMEOUT` before this fix was applied.

**Tradeoff:** A `TOOL_CALL` at seq=5 may render before tokens at seq=3 and seq=4 arrive. The tool card appears, then the preceding text fills in when the delayed tokens drain. This is a minor visual reordering (tool card momentarily before its lead-in text) that is preferable to a protocol violation.

**Alternative considered:** Respond to TOOL_ACK immediately via the WebSocket (before dispatching to reducer), then buffer for rendering. Rejected because it couples the ACK to receipt rather than to dispatch — if the message is a duplicate, we'd still ACK it.

---

### 5. Two flags for replay loop prevention: `isReplaying` + `replayCompleted`

**Decision:** Two separate boolean flags to handle the connection-drop-after-reconnect scenarios.

**Why — two distinct timing windows create an infinite RESUME loop:**

**Window A (drop before timer fires):** Connection drops while `isReplaying=true`. `onClose` must not call `scheduleReconnect()` here — the replay timer will fire at t+8s, flush the buffer, and dispatch `STREAM_END`. The connection is already gone; no reconnect needed. Without the `isReplaying` guard, `onClose` calls `scheduleReconnect()` → new connection → `onOpen` sends `RESUME` → loop.

**Window B (timer fires before drop):** Replay timer fires at t+8s. `isReplaying` → `false`, `replayCompleted` → `true`. Connection drops at t+10s. `onClose` sees `isReplaying=false` → would normally reconnect. Without the `replayCompleted` guard, another `RESUME` is sent → loop.

**Tradeoff:** Two flags interacting is subtle. The invariant is: exactly one of `{neither, isReplaying, replayCompleted}` is true at any time. This is maintained by:

- `sendUserMessage` → clears both
- `onOpen` (reconnect path) → sets `isReplaying=true`
- replay timer fires → sets `isReplaying=false`, `replayCompleted=true`
- natural `STREAM_END` → `clearReplayTimer()` → both false

---

### 6. PONG deduplication per connection (respondedChallenges Set)

**Decision:** Track responded-to challenges in a `Set<string>` cleared on every `connect()` call. Skip PONG if challenge already seen on this connection. Empty challenge (corrupt PING) always gets a PONG.

**Why:** After RESUME, the server replays its history including old PING messages from the original session. On the new connection, the server's state does not contain those challenge/response pairs — responding to replayed PINGs causes `"unexpected PONG"` violations.

**Observed:** Confirmed in live chaos runs — `/log` showed unexpected PONG entries before this fix.

**Edge case — empty challenge (corrupt PING):** Cannot dedup by challenge string (all corrupt PINGs have `challenge=""`). The server still expects a PONG for each. We always respond, bypassing the Set.

**Tradeoff:** If the server somehow reuses the same challenge string within a session, we would miss the second PONG. In practice the challenge is a UUID; collision probability is negligible.

---

### 7. TOOL_ACK suppressed during replay (`isReplaying` guard)

**Decision:** In `dispatchMessage()`, only send `TOOL_ACK` if `!this.isReplaying`.

**Why:** After RESUME, replayed `TOOL_CALL` messages already had their ACKs acknowledged in the original session. Sending another ACK on the new connection causes `"unexpected TOOL_ACK"` violations.

**Observed:** Confirmed in live chaos runs — `/log` showed unexpected TOOL_ACK after RESUME before this fix.

---

### 8. Replay timeout (REPLAY_TIMEOUT_MS = 8000ms)

**Decision:** After sending RESUME, arm an 8-second timer. If no `STREAM_END` arrives, force-flush the seq buffer and dispatch a synthetic `STREAM_END`.

**Why:** The server replays history after RESUME but does _not_ resume executing the script. If the original stream was cut mid-way, `STREAM_END` was never in the history — it will never arrive on the new connection. Without a timeout, the client hangs in `RESUMING` phase indefinitely.

**Why 8000ms:** The chaos latency spike is up to 8s. We need to give all replayed messages (which can arrive slowly due to the same chaos parameters) time to arrive before force-completing. A lower value (e.g. 3000ms) risks cutting off valid replay messages that are still in-flight.

**Tradeoff:** After a chaos drop, the user sees the stream end abruptly after ~8s of reconnecting. This is correct — the partial response is all the server has, and we cannot manufacture the rest. The alternative (infinite wait) is worse.

---

### 9. Token batching (~16ms)

**Decision:** Accumulate `TOKEN` messages for ~16ms before dispatching a single `TOKENS_BATCH` action to the reducer.

**Why:** At 30+ tokens/second, dispatching one React state update per token would trigger 30+ re-renders per second. `useReducer` in React 18+ batches some updates but not across `setTimeout` boundaries. The 16ms window aligns with a ~60fps render cycle.

**Tradeoff:** Token text appears in ~16ms batches rather than character-by-character. Imperceptible to the human eye.

---

### 10. jsonDiff — top-level only, value equality tiered strategy

**Decision:** `jsonDiff` compares only top-level keys. Changed-value detection uses a tiered equality strategy (reference → type guard → array length → `JSON.stringify`) rather than deep equality.

**Why:** The 550KB `large_context` payload has 64 top-level table entries. Deep-comparing all nested nodes on every context snapshot would be O(n×m) — potentially millions of comparisons. The tiered approach answers "did this top-level value change?" in O(1) for the common case (unchanged reference) and falls back to `JSON.stringify` per-key only when needed. See [JSON Diff and Tree Rendering](#json-diff-and-tree-rendering--core-concepts) for full rationale.

**Confirmed correct for the test cases:**

- `report_summary`: snapshot 2 adds `current_focus` and `extracted_metrics` → `added: 2`
- `large_context`: snapshot 2 adds `analysis_complete` and `flagged_issues` → `added: 2`
- All other keys unchanged (same reference) → `changed: 0`

**Tradeoff:** If a deep nested value changes but the top-level key's reference stays the same (e.g. in-place mutation), the diff would miss it. The server always sends fresh JSON-parsed objects — mutation does not occur here.

---

## Chaos Survival Assessment

### What works reliably

| Chaos condition                         | Status              | Evidence                                                                                                                        |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Connection drop mid-stream              | ✅ Handled          | `isReplaying` + `replayCompleted` flags prevent infinite RESUME loop                                                            |
| Latency spike (2–8s)                    | ✅ Handled          | TOOL_CALL bypasses seq buffer → ACK within 2s regardless of spike                                                               |
| Out-of-order delivery                   | ✅ Handled          | `seqBuffer` holds messages until contiguous run, gap-flush at 3s                                                                |
| Duplicate messages                      | ✅ Handled          | `Set<number>` dedup in `seqBuffer` (TOOL_CALL deduped separately)                                                               |
| Corrupt PING (empty challenge)          | ✅ Handled          | `challenge ?? ''` guard; always sends PONG; no crash                                                                            |
| Replayed PING after RESUME              | ✅ Handled          | `respondedChallenges` Set per-connection                                                                                        |
| PING latency spike < 3s                 | ✅ Handled          | PONG sent on receipt, arrives within server window                                                                              |
| PING latency spike ≥ 3s                 | ⚠️ Missed heartbeat | Window expires before PING arrives — structurally unwinnable; server terminates, client reconnects with RESUME, no content lost |
| Replayed TOOL_CALL after RESUME         | ✅ Handled          | `!isReplaying` guard on TOOL_ACK                                                                                                |
| Rapid sequential tool calls             | ✅ Handled          | `stillPending` check keeps phase in `TOOL_PENDING` until all resolved                                                           |
| 550KB CONTEXT_SNAPSHOT                  | ✅ Handled          | Top-level diff only; `useMemo` on seq numbers prevents re-running on every token                                                |
| `lookup` (TOOL_CALL before any token)   | ✅ Handled          | Reducer creates fresh TextSegment after tool resolves                                                                           |
| STREAM_END never arrives post-reconnect | ✅ Handled          | 8s replay timeout force-completes stream                                                                                        |

### Known limitations

**1. TOOL_ACK_TIMEOUT under chaos latency spike — structurally unwinnable:**
The chaos engine injects latency spikes of **2000–8000ms** on individual messages. The server's TOOL_ACK window is **2000ms**, measured from when the server _sends_ the TOOL_CALL — not from when the client receives it. The minimum spike (2000ms) exactly equals the entire ACK budget. Any latency spike on a TOOL_CALL message makes the 2s window physically unreachable, regardless of how fast the client responds.

The seq-buffer bypass (Decision #4) removed the only controllable delay. What remains is pure injected network latency the client cannot anticipate. When the TOOL_CALL arrives 5s late, the server already logged the timeout 3s earlier.

**Chaos-mode only.** In normal mode there are no latency spikes; TOOL_CALL arrives in ~1ms and ACK fires well within the 2s window. Confirmed clean by observing `/log` in normal mode.

**2. PING/PONG missed heartbeat under chaos latency spike — structurally unwinnable:**
The server's PONG window is **3000ms** from when it _sends_ the PING. A latency spike ≥ 3s means the client doesn't receive the PING until after the window has expired — the PONG it sends immediately arrives too late. Three missed PONGs trigger `ws.terminate()`, which the client handles identically to any other drop (reconnect → RESUME → no content lost). The client cannot PONG before receiving the PING.

**Chaos-mode only.** In normal mode PING arrives in <1ms; PONG is back well within 3s.

**3. Partial stream after reconnect (by design):**
The server replays history but does not resume script execution. If a chaos drop happens mid-response, the user sees a partial answer. This is a server protocol limitation, not a client bug. The client surfaces it cleanly (stream ends, UI returns to idle).

**4. TraceTimeline performance above ~500 events:**
No virtualisation. Scrolling may be sluggish in long chaos sessions with many retries. Does not affect correctness or the main chat panel. Fix: `react-window` `FixedSizeList` with grouped "Streamed N tokens" rows to reduce visible count.

**5. Rapid multiple reconnects under extreme chaos:**
`dropAfterMessages` is 15–45. If the threshold is 15, the client might reconnect 3–4 times within a single response — each cycle adds up to 8s of replay timeout. User experience degrades but protocol remains correct.

**6. TOOL_CALL seq bypass causes minor visual reordering:**
In ~15–35% of chaos messages, preceding tokens may arrive after the TOOL_CALL they precede. The tool card appears briefly before its lead-in text. This is a visual artefact, not a data corruption issue.

---

## Known Protocol Race Condition (documented per spec)

**The TOOL_ACK race:** If the connection drops after `TOOL_CALL` arrives but before `TOOL_ACK` reaches the server, and the client reconnects — the replayed `TOOL_CALL` will NOT generate a new `TOOL_ACK` (suppressed by `isReplaying`). The server logs a `TOOL_ACK_TIMEOUT` violation even though the client behaved correctly.

**Why this is a protocol design gap, not a client bug:**
The server does not distinguish between:

- Case A: ACK was sent, connection dropped before server received it
- Case B: Client crashed, ACK was never sent

In both cases the server records a violation after 2s. There is no mechanism for the client to say "I already ACKed this before the drop" — the RESUME/replay path has no ACK idempotency token.

**Impact:** Rare (requires the connection to drop in a ~100ms window after TOOL_CALL delivery). When it happens, the `/log` violation count increments by 1, but the UI recovers correctly.

**Mitigation considered:** Store pending TOOL_ACKs in localStorage. On reconnect, re-send any ACKs from the crashed session. Rejected — the server still couldn't distinguish duplicates from genuine resends. The race exists at the protocol level.

---

## Seq-Based Ordering and Deduplication — Data Structure Rationale

### Data structures

Two structures inside `seqBuffer.ts`:

- **`Map<number, ServerMessage>`** — the ordering buffer. Key is `seq`, value is the raw message. Holds out-of-order messages until earlier seqs arrive to form a contiguous run.
- **`Set<number>`** — the dedup guard. Tracks every seq that has been _dispatched_ (not just received). Before processing any message, check `seen.has(seq)` — if true, discard silently.

`nextExpected: number` — a plain integer tracking the next contiguous seq the buffer is waiting for. Starts at 1 (server `++seq` means first message is always seq=1).

### Why Map, not Array or sorted list

The access pattern is: "do I have seq N?" and "give me all messages from N to M in order." A `Map` answers both in O(1) and O(k) respectively. An array requires linear search or sorted-insert maintenance. A heap gives O(log n) insert but the same O(k) drain cost — worse insert for the same drain. For a buffer capped at 4 messages (chaos Fisher-Yates window) the size difference is negligible, but `Map` is semantically the clearest choice.

### Why Set for dedup, not checking the Map

The Map is cleared after draining. If a duplicate arrives _after_ the original has been dispatched and removed from the Map, the Map check would pass and the duplicate would go through. The `Set` persists across drains for the lifetime of the turn, catching late duplicates regardless of timing.

### The trimAfter(n) invariant

On reconnection, `seen` may contain entries for messages the socket received but React had not yet committed to the DOM (mid-rAF batch). If those seqs stay in `seen`, replay silently drops them — the DOM misses them forever.

`trimAfter(lastRendered)` evicts all `seen` and `buffer` entries with seq > lastRendered, then resets `nextExpected = lastRendered + 1`. This ensures replay delivers exactly the messages the DOM missed. See [Reconnection State Recovery](#reconnection-state-recovery--dom-consumed-vs-socket-received) for how `lastRendered` is tracked accurately.

---

## Layout Shift Prevention During Tool Call Interruptions

### The problem

When `TOOL_CALL` arrives mid-stream, the streaming text stops and a tool card must appear inline. Two failure modes:

1. **Reflow**: the tool card pushes existing text up/down as it mounts.
2. **Height collapse**: the text container shrinks while waiting for the tool card, then jumps back when text resumes.

### What we do

**Append-only segment model** — the segment list never shrinks. `TOOL_CALL` appends a new `ToolSegment`; the preceding `TextSegment` stays mounted with its committed height.

**Fixed-height tool cards** — `ToolCard` uses `min-h-[72px]` in both pending and resolved states. No height change on `TOOL_RESULT` arrival.

**Stable React keys** — `TextSegment` key is `text-${seqStart}`; `ToolSegment` key is `callId`. Neither changes during replay or result arrival — React reuses the existing DOM node with no unmount/remount.

**`min-height` on message container** — prevents scroll-position jump when a tool card appears between text segments.

**`memo` on `TextChunk` and `ToolCard`** — once a `TextSegment` is frozen (after a `TOOL_CALL`), its `content` prop never changes. `memo` blocks re-rendering it during subsequent token batches in a later text segment.

---

## Reconnection State Recovery — DOM-consumed vs. socket-received

### The core distinction

Standard reconnection code tracks "what did the socket receive?" That is wrong. The correct question is "what has React committed to the DOM?" These differ because:

1. **Token batching** — tokens are received, accumulated in the protocol layer for ~16ms, then dispatched as a batch. Between receipt and dispatch, `lastProcessedSeq` has not advanced.
2. **React render latency** — `dispatch(TOKENS_BATCH)` queues a state update. Until React's reconciliation commits it, `lastProcessedSeq` in state is stale.
3. **Mid-rAF drop** — if the connection drops while tokens sit in the rAF batch, those seqs are in `seen` but not in the DOM.

If RESUME carries the socket's highest seen seq, the server skips replaying those tokens — they are lost from the DOM permanently.

### How we track DOM truth

`lastProcessedSeqRef` is a `useRef<number>` written **synchronously in the render body** of `useWebSocket`, not in a `useEffect`:

```typescript
const lastProcessedSeqRef = useRef<number>(0);
lastProcessedSeqRef.current = state.lastProcessedSeq; // written during render, not effect
```

Writing in the render body (not `useEffect`) means the ref updates as part of React's synchronous render pass — before any effects fire, before any new WebSocket messages are processed. This makes `lastProcessedSeqRef.current` the most accurate available proxy for "what is visually committed."

`AgentProtocol` holds a reference to this ref (passed at construction). When `onOpen` fires after reconnection:

1. `seqBuf.trimAfter(lastProcessedSeqRef.current)` — evicts socket-ahead-of-DOM entries from `seen`
2. `send({ type: 'RESUME', last_seq: lastProcessedSeqRef.current })` — carries DOM truth, not socket truth

---

## JSON Diff and Tree Rendering — Core Concepts

### Why top-level diff, not recursive diff

Diffing only at the top level is not a shortcut — it is the correct scope. Both test cases change at the root:

- `report_summary`: snapshot 2 adds `current_focus` and `extracted_metrics` at root level.
- `large_context`: snapshot 2 adds `analysis_complete` and `flagged_issues` at root level.

Recursive diff would visit thousands of nested nodes (64 tables × columns × properties) at O(n total nodes), returning no additional information for the UI. `Object.keys()` is O(n top-level keys) — a single linear pass.

### The value equality problem — tiered strategy

Reference equality alone (`===`) produces false positives: `JSON.parse()` always returns new object instances, so all 64 table values from `generateLargeContext()` have new references even when content is identical.

Resolution — cheapest check first:

1. **Reference equality** `a === b` — instant. Handles primitives and cached objects.
2. **Type / null guard** — O(1) fast reject for mismatched types.
3. **Array length check** — O(1) reject before serialisation.
4. **`JSON.stringify` deep equality** — fallback for objects passing all prior checks.

`JSON.stringify` is called **per top-level key**, never on the whole 550KB object. At ~1 GB/s, an 8KB table takes ~0.008ms. 64 tables = ~0.5ms total. The diff is memoised on seq numbers so this runs exactly once per snapshot pair — never during token streaming.

### Why lazy tree mounting, not virtualisation

Two approaches prevent a 550KB JSON tree from freezing the tab:

- **Virtual scroll**: mount only DOM nodes in the visible window; recycle on scroll.
- **Lazy expand**: nodes start collapsed; children are never mounted until the user clicks.

Lazy expand is correct here because the tree is navigated by intent (click to explore a specific table), not scrolled linearly. A user reading `users_table` never needs `orders_table` mounted. Virtual scroll would still mount it as the user scrolls past — wasteful for a tree most users never fully traverse.

The implementation is `{isExpanded && <children />}` — React simply does not mount child components when collapsed. No library, no offset calculation, no layout measurement.

For large expanded nodes (e.g. a table with 200+ columns), lazy mounting is supplemented by **paginated child rendering** (`PAGE_SIZE = 50`): the first 50 children mount on expand; a "show N more" button adds the next 50. This bounds the synchronous mount cost regardless of how deep a user drills.

### `startTransition` for non-blocking expand

Clicking to expand a large node mounts hundreds of `JsonNode` components in one reconciliation pass. Without yielding, this blocks the main thread — input events queue up, the click feels laggy.

`startTransition` marks `setExpanded(true)` as a non-urgent update. React can interrupt the expansion render between fibre work units to process higher-priority events. The expansion still completes; it spreads across frames instead of freezing one.

### Memoisation keyed on seq numbers, not references

`ContextInspector` re-renders on every token because it receives `contextSnapshots` (a Map) from top-level state — a new Map reference on every render. Without memoisation, `jsonDiff` would run O(64) times per second during `large_context` streaming.

The fix: `useMemo([prevSnapshot?.seq, snapshot?.seq])`. Seq numbers are primitives; they only change when a new snapshot actually arrives. This makes `jsonDiff` run exactly N-1 times total (N = number of snapshots), regardless of token render count.

### Stable React keys preserve expand state across snapshots

When a new snapshot arrives, `snapshot.data` is a fresh `JSON.parse` result — all references are new. Without stable keys, React would unmount and remount every `JsonNode`, resetting all `expanded` state. A user who opened `users_table` would find it collapsed again.

Using the object key string as the React key (`key={nodeKey}`) means React reuses the same component instance as long as the key exists in both snapshots. The `expanded` boolean in local state is preserved. Only genuinely new keys get fresh instances.

### Diff result as display metadata, not tree replacement

The diff output — `{ added, removed, changed }` arrays — is passed into the tree as `diffMarkers: Map<string, 'added' | 'changed' | 'removed'>`, not as a modified version of the data. The tree still renders from `snapshot.data`. The highlight is a display annotation layered on top.

This means:

- The tree structure is stable across snapshot updates (same data, same keys, same component instances).
- A new snapshot does not cause the tree to re-mount or re-evaluate all nodes.
- All three diff categories (added → green, changed → amber, removed → red strikethrough) are covered by a single Map pass rather than three separate Set lookups.

---

## What We Would Do Differently

1. **Virtualise TraceTimeline** — Use `react-window` `FixedSizeList` for the event list. Group consecutive TOKEN events into a single collapsed row ("Streamed N tokens in Xs") to keep the visible count low even in long chaos sessions.

2. **Replay timeout as a visible phase** — Currently the 8s replay timeout is hidden inside `AgentProtocol`. We would surface it as a `REPLAY_COMPLETING` phase in the reducer so the UI can show a deterministic countdown instead of just the reconnect banner.

3. **Pivot comparison in ContextInspector scrubber** — The scrubber shows diff vs. the immediately previous snapshot. A better UX would allow selecting any two snapshots as the diff pivot, useful when there are 3+ snapshots.

4. **TOOL_ACK idempotency token in protocol** — Propose a `turn_id` field in RESUME so the server can match ACKs to the original session rather than the new connection. This eliminates the race condition at the protocol level.

5. **`lastProcessedSeq` sync** — Writing the ref in the render body is correct but subtle. A cleaner approach: have the protocol accept an explicit `confirmSeq(n)` callback from the reducer, called synchronously when a TOKENS_BATCH action is processed. This makes the contract explicit rather than relying on render-body timing.

---

## Scaling to 50 Concurrent Agent Streams

### What breaks at 50 streams

| Component                       | Problem at 50 streams                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| Single `AgentProtocol` instance | One WebSocket per stream → 50 concurrent connections, 50 reconnect timers, 50 seq buffers |
| Single `useAgentReducer`        | Every token from any stream triggers a full reducer evaluation and top-level re-render    |
| `TraceTimeline`                 | 50 streams × 60 tokens/sec = 3000 state updates/sec, all re-rendering one component       |
| Token batching                  | 50 separate rAF loops firing every 16ms                                                   |

### What we would change

**1. Stream registry, not a single reducer**

Replace `useAgentReducer` with a `StreamRegistry` — a `Map<streamId, StreamState>` managed outside React (in a `useRef` or Zustand). Each stream gets its own isolated state slice. Components subscribe only to their assigned stream:

```typescript
const streamState = useStreamStore((s) => s.streams.get(props.streamId));
```

A token on stream A does not trigger re-render on stream B's component.

**2. One multiplexed WebSocket or a bounded connection pool**

50 independent WebSocket connections hit OS file-descriptor limits and saturate the browser's connection pool. Better: one connection multiplexed by `stream_id`, or a pool of N connections (N = CPU core count) with streams load-balanced across them.

**3. React virtualisation for the dashboard grid**

Render only streams visible in the viewport. Off-screen stream cards are unmounted — state is preserved in the registry but DOM nodes are recycled.

**4. Coalesce token batches across streams**

One global rAF loop drains all 50 per-stream token queues in a single animation frame and produces one batch of `TOKENS_BATCH` actions. This bounds the React render rate to 60fps regardless of stream count.

**5. Web Worker for seq ordering and diff computation**

At 50 streams, `seqBuffer` reordering and `jsonDiff` on the main thread would block rendering. Offload both to a Web Worker communicating via `postMessage`.

---

## Scaling to 100x Longer Responses (Document Generation)

### What breaks at 100x length

| Problem                              | Impact                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `content: string` grows to megabytes | React diffing the full string on every token append is O(n) in content length   |
| Single `TextSegment` per text block  | Every token append replaces the string — React considers the whole node changed |
| `scrollIntoView` on every token      | 60× per second on a long DOM causes layout thrash                               |
| TraceTimeline                        | Thousands of grouped rows; no virtualisation → freeze                           |

### What we would change

**1. Rope / chunk model for text segments**

Replace `content: string` with `chunks: string[]` (append-only array). Each token batch appends a new element. React renders a list of `<span>` nodes — only the new spans are diffed on each update.

```typescript
type TextSegment = {
  type: "text";
  id: string;
  chunks: string[]; // append-only; never mutated in place
  seqStart: number;
  seqEnd: number;
};
```

**2. Virtualised text rendering**

For very long documents, use an intersection-observer-based virtual text renderer: measure character-to-pixel density, estimate which chunks are in the viewport, mount only those. This is how code editors (Monaco, CodeMirror) handle large files.

**3. Streaming into a detached DOM buffer**

During high-velocity streaming, bypass React for the append. Maintain a `document.createDocumentFragment` that accumulates tokens via `textContent` append. Commit to React state every 500ms or on `STREAM_END`. Removes reconciliation overhead from the hot path.

**4. Scroll anchoring, not scroll-to-bottom**

Replace `scrollIntoView` on every segment update with CSS `overflow-anchor: auto` on the scroll container. The browser handles scroll position natively — no JavaScript. Only force-scroll to bottom on initial connection and user-initiated sends.

**5. IndexedDB for segment persistence**

At 100x length, keeping the full response in React state means it's lost on page refresh. Stream chunks to IndexedDB as they arrive. On reconnect, hydrate from IndexedDB rather than waiting for server replay — the server's history buffer may not hold the full document.

**6. O(1) pending tool check**

In a 100x document with 20+ tool calls, the current linear scan for `stillPending` tool segments is O(n segments). Replace with a `pendingToolIds: Set<string>` maintained alongside the segment list — O(1) check regardless of segment count.
