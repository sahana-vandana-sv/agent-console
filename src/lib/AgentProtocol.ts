// Zero React imports — pure WebSocket + protocol logic.
import type { ClientMessage, ServerMessage } from '../types/protocol';
import type { AgentAction } from '../types/state';
import { createSeqBuffer } from './seqBuffer';
import { unsafeJsonParse } from './escape-hatch';

const WS_URL            = 'ws://localhost:4747/ws';
const BACKOFF           = [500, 1000, 2000, 4000, 10000] as const;
const GAP_TIMEOUT_MS    = 3000;
// After RESUME, the server replays history but never continues execution.
// STREAM_END may never arrive. Hard upper-bound timeout:
const REPLAY_TIMEOUT_MS = 15000;
// If no message arrives for this long during replay, treat it as complete.
// Replay uses rawSend (bypasses chaos engine) so live-stream latency spikes
// (up to 8s) do NOT apply. However large payloads (550KB context snapshots)
// can cause >1s gaps between consecutive rawSend calls on a loaded machine.
// 3000ms matches the gap timer and is safe for any localhost processing delay.
const REPLAY_IDLE_MS = 3000;

export class AgentProtocol {
  private ws: WebSocket | null = null;
  private dispatch: (action: AgentAction) => void;

  // Ref supplied by useWebSocket — written synchronously on every React render,
  // so it always holds the latest committed seq even if onOpen() fires before
  // a useEffect callback would have had a chance to call updateLastProcessedSeq().
  private lastProcessedSeqRef: { current: number };
  private isReconnecting    = false;
  private sessionStarted    = false;   // true only after first USER_MESSAGE
  // True from RESUME sent until STREAM_END (natural or timeout).
  // A drop during replay must NOT trigger another reconnect — the replay timer
  // will force-complete the stream instead. Without this flag, onClose cancels
  // the timer and immediately schedules a new reconnect → infinite RESUME loop.
  private isReplaying       = false;
  // Set when the replay timer fires (stream force-completed). Prevents a drop
  // that arrives AFTER the timer fires (but before the connection closes) from
  // triggering yet another reconnect. Reset only when the user sends a new message.
  private replayCompleted   = false;
  // Set on every STREAM_END dispatch (natural or via replay timers). Prevents
  // chaos from dropping the post-stream connection and triggering a RESUME loop
  // (the stream is done — reconnecting would just replay the same STREAM_END).
  // Reset only in sendUserMessage() so the next turn reconnects normally.
  private streamComplete    = false;
  private reconnectAttempt  = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Buffered USER_MESSAGE content when sendUserMessage() is called while ws is
  // null (connection dropped after stream end, no reconnect was scheduled).
  // Sent in onOpen() on the fresh connection.
  private pendingUserMessage: string | null = null;

  private seqBuf       = createSeqBuffer();
  private gapTimer:    ReturnType<typeof setTimeout> | null = null;
  // Hard upper-bound timeout after RESUME — fires if STREAM_END never arrives
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  // Idle detector — only armed after the first NEW event (seq > resumeLastSeq)
  // arrives. Fires when the server's burst ends and goes silent.
  private replayIdleTimer: ReturnType<typeof setTimeout> | null = null;
  // The lastProcessedSeq value at the moment RESUME was sent. Used to detect
  // when the server has crossed into "new" events we haven't seen yet.
  private resumeLastSeq = 0;
  // True once we've received at least one event with seq > resumeLastSeq.
  // The idle timer must not start until this is true — before then, silence
  // between dropped-replayed events would falsely end the stream.
  private replayNewEventSeen = false;

  // Tracks PING challenges already responded to on the CURRENT connection.
  // After RESUME, the server replays history including old PINGs. Those replayed
  // PINGs have challenges the new connection's server state doesn't recognise —
  // responding to them causes "unexpected PONG" violations.
  // Reset on every new connect(); non-empty challenges deduped; empty challenge
  // (corrupt PING) bypasses dedup so each corrupt PING still gets a PONG.
  private respondedChallenges = new Set<string>();

  private tokenBatch: Array<{ seq: number; text: string }> = [];
  private tokenBatchStreamId = '';
  // Wall-clock time (Date.now()) when the first and last token of the current
  // batch arrived at the WebSocket — before rAF delay. Used for accurate
  // streaming-time display in the trace timeline.
  private tokenBatchFirstArrivalTs = 0;
  private tokenBatchLastArrivalTs  = 0;
  // rAF id — null when no flush is pending. Using rAF (not setTimeout) means the
  // batch flushes exactly once per browser paint frame, giving true per-frame
  // incremental rendering rather than a coarse 16ms fixed interval.
  private tokenBatchTimer: number | null = null;

  constructor(
    dispatch: (action: AgentAction) => void,
    lastProcessedSeqRef: { current: number },
  ) {
    this.dispatch = dispatch;
    this.lastProcessedSeqRef = lastProcessedSeqRef;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  connect(): void {
    this.respondedChallenges.clear();   // fresh connection — old challenges are invalid
    this.ws = new WebSocket(WS_URL);
    this.ws.onopen    = () => this.onOpen();
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
    this.ws.onerror   = () => this.onClose();   // hard terminate fires onerror before onclose
    this.ws.onclose   = () => this.onClose();
  }

  sendUserMessage(content: string): void {
    this.sessionStarted = true;
    this.seqBuf.reset();
    this.clearGapTimer();
    this.clearReplayTimer();
    this.replayCompleted = false;
    this.streamComplete  = false;
    this.flushTokenBatch();
    this.dispatch({ type: 'USER_MESSAGE_SENT' });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Connection was dropped after stream completed (no reconnect was scheduled
      // because streamComplete suppressed it). Buffer the message and open a fresh
      // connection — onOpen() will send it.
      this.pendingUserMessage = content;
      this.isReconnecting = false;   // NOT a RESUME reconnect — fresh connection
      this.connect();
    } else {
      this.send({ type: 'USER_MESSAGE', content });
    }
  }

destroy(): void {
    this.reconnectTimer  && clearTimeout(this.reconnectTimer);
    this.gapTimer        && clearTimeout(this.gapTimer);
    this.replayIdleTimer && clearTimeout(this.replayIdleTimer);
    this.tokenBatchTimer && cancelAnimationFrame(this.tokenBatchTimer);
    this.replayTimer     && clearTimeout(this.replayTimer);
    this.isReconnecting      = false;
    this.isReplaying         = false;
    this.replayCompleted     = false;
    this.streamComplete      = false;
    this.sessionStarted      = false;
    this.pendingUserMessage  = null;
    this.ws?.close();
    this.ws = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // 📤 CLIENT → SERVER
      console.log('%c📤 CLIENT→SERVER', 'color:#22c55e;font-weight:bold', msg);
      this.ws.send(JSON.stringify(msg));
    }
  }

  private onOpen(): void {
    if (this.isReconnecting && this.sessionStarted) {
      // RESUME must be the very first message after a genuine mid-session reconnect.
      // Guard: only send if a USER_MESSAGE was ever sent — RESUME { last_seq: 0 }
      // on a pre-session drop is meaningless and noisy in the server log.
      this.resumeLastSeq      = this.lastProcessedSeqRef.current;
      this.replayNewEventSeen = false;
      // Evict from `seen` any seqs that arrived but were never committed to the
      // reducer (seq > resumeLastSeq). The connection may have dropped mid
      // token-batch (16ms rAF window) or mid gap-timer flush, leaving seen ahead
      // of lastProcessedSeq. Without this, the server's replay of those seqs
      // hits seen.has(seq)→true and is silently dropped — permanent render gap.
      this.seqBuf.trimAfter(this.resumeLastSeq);
      this.send({ type: 'RESUME', last_seq: this.resumeLastSeq });
      this.dispatch({ type: 'RECONNECT_SUCCESS' });
      this.isReconnecting   = false;
      this.reconnectAttempt = 0;
      this.isReplaying      = true;
      // Chaos: server replays history but never continues execution.
      // STREAM_END may never arrive — give up after REPLAY_TIMEOUT_MS.
      this.armReplayTimer();
    } else {
      this.isReconnecting = false;
      this.dispatch({ type: 'WS_OPEN' });
      if (this.pendingUserMessage !== null) {
        const content = this.pendingUserMessage;
        this.pendingUserMessage = null;
        this.send({ type: 'USER_MESSAGE', content });
      }
    }
  }

  private armReplayTimer(): void {
    this.replayTimer && clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => {
      this.replayTimer     = null;
      this.isReplaying     = false;
      this.replayCompleted = true;
      this.streamComplete  = true;
      const flushed = this.seqBuf.flush();
      for (const m of flushed) this.dispatchMessage(m);
      this.flushTokenBatch();
      this.dispatch({ type: 'STREAM_END', streamId: '__replay_timeout__' });
    }, REPLAY_TIMEOUT_MS);
  }

  private armReplayIdleTimer(): void {
    if (this.replayIdleTimer !== null) clearTimeout(this.replayIdleTimer);
    this.replayIdleTimer = setTimeout(() => {
      this.replayIdleTimer = null;
      if (!this.isReplaying) return;   // natural STREAM_END already cleared it
      console.log('%c⏱ REPLAY IDLE', 'color:#f97316;font-weight:bold',
        `No message for ${REPLAY_IDLE_MS}ms — forcing STREAM_END`);
      // Cancel the hard timeout — idle detector fired first
      if (this.replayTimer !== null) { clearTimeout(this.replayTimer); this.replayTimer = null; }
      this.isReplaying     = false;
      this.replayCompleted = true;
      this.streamComplete  = true;
      const flushed = this.seqBuf.flush();
      for (const m of flushed) this.dispatchMessage(m);
      this.flushTokenBatch();
      this.dispatch({ type: 'STREAM_END', streamId: '__replay_idle__' });
    }, REPLAY_IDLE_MS);
  }

  private clearReplayTimer(): void {
    if (this.replayTimer !== null) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    if (this.replayIdleTimer !== null) {
      clearTimeout(this.replayIdleTimer);
      this.replayIdleTimer = null;
    }
    this.isReplaying     = false;
    this.replayCompleted = false;
  }

  private onMessage(raw: string): void {
    const msg = unsafeJsonParse(raw) as ServerMessage;
    // 📥 SERVER → CLIENT (raw, before seq ordering)
    console.log('%c📥 SERVER→CLIENT', 'color:#60a5fa;font-weight:bold', `seq=${msg.seq} type=${msg.type}`, msg);

    // During replay: arm the idle timer on EVERY message (not just new events).
    // Previously the idle timer was gated on replayNewEventSeen — this caused a
    // false silence window when there was a server-side delay between the last
    // old event and the first new event (normal batching gap), which triggered
    // the idle timer mid-replay.
    //
    // Now we reset the idle on every message so it only fires 9 500 ms after
    // the truly last message the server sends. For the common case (stream
    // completed before drop), the replayed STREAM_END now fires immediately
    // (see STREAM_END handler below) so the idle timer is cancelled before it
    // ever fires. The idle is only the backstop for "stream cut off mid-execution"
    // where no STREAM_END exists in history.
    if (this.isReplaying && 'seq' in msg) {
      const s = (msg as { seq: number }).seq;
      if (s > this.resumeLastSeq) {
        this.replayNewEventSeen = true;
      }
      this.armReplayIdleTimer();
    }

    const ready = this.seqBuf.add(msg);

    if (ready.length === 0) {
      // 🕐 SEQ BUFFER: message held — waiting for gap to fill
      console.log('%c🕐 SEQ BUFFER', 'color:#f59e0b;font-weight:bold', `seq=${msg.seq} HELD (gap — waiting for contiguous run)`);
    } else if (ready.length > 1) {
      // 🔓 SEQ BUFFER: multiple messages drained at once (chaos flush or gap filled)
      console.log('%c🔓 SEQ BUFFER', 'color:#a78bfa;font-weight:bold', `DRAINED ${ready.length} messages: seqs=[${ready.map(m=>m.seq).join(',')}]`);
    }

    for (const m of ready) {
      this.dispatchMessage(m);
    }

    // If there are still messages waiting in the buffer, arm the gap timer.
    if (this.seqBuf.hasPending()) {
      this.armGapTimer();
    } else {
      this.clearGapTimer();
    }
  }

  private onClose(): void {
    if (!this.ws) return;           // already destroyed
    this.ws = null;
    this.clearGapTimer();
    this.flushTokenBatch();
    this.dispatch({ type: 'WS_CLOSE' });

    if (this.isReplaying || this.replayCompleted || this.streamComplete) {
      // Two cases — both must skip reconnect:
      // 1. isReplaying: drop arrived before replay timer fired. Timer will
      //    force-flush and dispatch STREAM_END — no reconnect needed.
      // 2. replayCompleted: replay timer already fired (stream force-completed),
      //    but the connection only drops now. Stream is already done — reconnecting
      //    would send RESUME again → infinite loop.
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.isReconnecting = true;
    const delay = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private armGapTimer(): void {
    if (this.gapTimer !== null) return;   // already armed
    this.dispatch({ type: 'SEQ_GAP_DETECTED' });
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      const flushed = this.seqBuf.flush();
      for (const m of flushed) this.dispatchMessage(m);
      this.dispatch({ type: 'SEQ_GAP_FILLED' });
    }, GAP_TIMEOUT_MS);
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private dispatchMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'PING': {
        const challenge = msg.challenge ?? '';
        // Always record the received PING in the trace timeline.
        this.dispatch({ type: 'PING_RECEIVED', seq: msg.seq, challenge });
        // Corrupt PING (empty challenge) always gets a PONG — no dedup.
        // Non-empty challenge: dedup by challenge string so replayed PINGs
        // (sent by server during RESUME history replay) don't trigger a second
        // PONG on the new connection where those challenges are unknown.
        if (challenge === '' || !this.respondedChallenges.has(challenge)) {
          if (challenge !== '') this.respondedChallenges.add(challenge);
          this.send({ type: 'PONG', echo: challenge });
          this.dispatch({ type: 'PONG_SENT', echo: challenge });
        }
        break;
      }

      case 'TOKEN': {
        // Accumulate tokens into a batch and flush on the next animation frame.
        // rAF aligns the flush with the browser's vsync, so each paint cycle shows
        // all tokens that arrived since the last frame — true incremental rendering.
        // Tokens that arrive mid-frame are grouped into one React dispatch → one commit.
        if (this.tokenBatchStreamId && this.tokenBatchStreamId !== msg.stream_id) {
          // Stream ID changed mid-batch — flush immediately before starting new batch
          this.flushTokenBatch();
        }
        const now = Date.now();
        if (this.tokenBatch.length === 0) {
          this.tokenBatchFirstArrivalTs = now;   // first token of this batch
        }
        this.tokenBatchLastArrivalTs = now;      // updated on every arrival
        this.tokenBatch.push({ seq: msg.seq, text: msg.text });
        this.tokenBatchStreamId = msg.stream_id;
        if (this.tokenBatchTimer === null) {
          // 🎨 rAF ARMED: next browser paint will flush the token batch
          console.log('%c🎨 rAF ARMED', 'color:#f472b6;font-weight:bold', `seq=${msg.seq} text="${msg.text}" — batch will flush at next paint`);
          this.tokenBatchTimer = requestAnimationFrame(() => this.flushTokenBatch());
        } else {
          // Token arrived before rAF fired — accumulated into same batch
          console.log('%c➕ TOKEN ACCUMULATED', 'color:#fb923c', `seq=${msg.seq} text="${msg.text}" — batch size now ${this.tokenBatch.length}`);
        }
        break;
      }

      case 'TOOL_CALL': {
        // Flush any pending tokens FIRST so the text segment is frozen at the
        // exact boundary before the tool card appears.
        console.log('%c🔧 TOOL_CALL received', 'color:#f59e0b;font-weight:bold', `call_id=${msg.call_id} tool=${msg.tool_name} — flushing token batch first to freeze text`);
        this.flushTokenBatch();
        this.dispatch({
          type: 'TOOL_CALL',
          seq: msg.seq,
          callId: msg.call_id,
          toolName: msg.tool_name,
          args: msg.args,
          streamId: msg.stream_id,
        });
        // Send TOOL_ACK synchronously — no setTimeout.
        //
        // The previous setTimeout(0) yielded to the event loop, allowing a
        // TOOL_RESULT that arrived in the same network burst to be processed
        // BEFORE the ACK went out (TOOL_RESULT onmessage fires during the yield).
        // Sending synchronously eliminates this race and ensures ACK goes out
        // in the same call stack as the TOOL_CALL dispatch — minimum possible
        // latency.
        //
        // During replay, suppress ACKs for calls the server already received
        // (seq ≤ resumeLastSeq — filtered by seen Set, can't reach here).
        // If a TOOL_CALL passes dedup during replay (seq > resumeLastSeq) the
        // original ACK was never delivered — send a fresh ACK.
        if (!this.isReplaying || msg.seq > this.resumeLastSeq) {
          console.log('%c✅ TOOL_ACK sent', 'color:#22c55e;font-weight:bold', `call_id=${msg.call_id}`);
          this.send({ type: 'TOOL_ACK', call_id: msg.call_id });
        }
        break;
      }

      case 'TOOL_RESULT': {
        this.dispatch({
          type: 'TOOL_RESULT',
          seq: msg.seq,
          callId: msg.call_id,
          result: msg.result,
        });
        break;
      }

      case 'CONTEXT_SNAPSHOT': {
        this.dispatch({
          type: 'CONTEXT_SNAPSHOT',
          seq: msg.seq,
          contextId: msg.context_id,
          data: msg.data,
        });
        break;
      }

      case 'STREAM_END': {
        // Accept the replayed STREAM_END even if seq ≤ resumeLastSeq.
        //
        // Rationale: if STREAM_END is in the server's history it means the stream
        // completed BEFORE the drop. After replaying catch-up events there is
        // nothing more coming — dispatching STREAM_END immediately is correct and
        // avoids the 9 500 ms idle-timer wait.
        //
        // Previously we skipped replayed STREAM_ENDs (seq ≤ resumeLastSeq) and
        // relied on the idle timer to finish the stream. That caused a 9.5 s delay
        // in the common "stream completed before drop" case and also fired
        // prematurely when latency spikes created >500 ms gaps mid-replay.
        if (this.isReplaying && msg.seq <= this.resumeLastSeq) {
          console.log('%c✅ REPLAY: accepting already-completed STREAM_END', 'color:#22c55e',
            `seq=${msg.seq} resumeLastSeq=${this.resumeLastSeq} — stream was done before drop`);
        }
          // Cancel timers without resetting replayCompleted (clearReplayTimer resets it).
        if (this.replayTimer !== null) { clearTimeout(this.replayTimer); this.replayTimer = null; }
        if (this.replayIdleTimer !== null) { clearTimeout(this.replayIdleTimer); this.replayIdleTimer = null; }
        this.isReplaying    = false;
        this.streamComplete = true;
        this.flushTokenBatch();
        this.dispatch({ type: 'STREAM_END', streamId: msg.stream_id });
        break;
      }

      case 'ERROR': {
        this.dispatch({ type: 'ERROR', code: msg.code, message: msg.message });
        break;
      }
    }
  }

  private flushTokenBatch(): void {
    if (this.tokenBatchTimer !== null) {
      cancelAnimationFrame(this.tokenBatchTimer);
      this.tokenBatchTimer = null;
    }
    if (this.tokenBatch.length === 0) return;
    // 🚀 rAF FIRED → dispatching TOKENS_BATCH to React reducer
    console.log(
      '%c🚀 rAF FLUSH → TOKENS_BATCH', 'color:#f472b6;font-weight:bold',
      `${this.tokenBatch.length} token(s): "${this.tokenBatch.map(t=>t.text).join('')}"`,
      `seqs=[${this.tokenBatch.map(t=>t.seq).join(',')}]`
    );
    this.dispatch({
      type: 'TOKENS_BATCH',
      tokens: this.tokenBatch,
      streamId: this.tokenBatchStreamId,
      firstArrivalTs: this.tokenBatchFirstArrivalTs,
      lastArrivalTs:  this.tokenBatchLastArrivalTs,
    });
    this.tokenBatch = [];
    this.tokenBatchStreamId      = '';
    this.tokenBatchFirstArrivalTs = 0;
    this.tokenBatchLastArrivalTs  = 0;
  }
}
