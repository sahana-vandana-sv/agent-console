// Zero React imports — pure WebSocket + protocol logic.
import type { ClientMessage, ServerMessage } from '../types/protocol';
import type { AgentAction } from '../types/state';
import { createSeqBuffer } from './seqBuffer';
import { unsafeJsonParse } from './escape-hatch';

const WS_URL            = 'ws://localhost:4747/ws';
const BACKOFF           = [500, 1000, 2000, 4000, 10000] as const;
const GAP_TIMEOUT_MS    = 3000;
// After RESUME, the server replays history but never continues execution.
// STREAM_END may never arrive. Give up after this long and force-complete.
const REPLAY_TIMEOUT_MS = 8000;

export class AgentProtocol {
  private ws: WebSocket | null = null;
  private dispatch: (action: AgentAction) => void;

  // Operational state — never triggers re-renders
  private lastProcessedSeq  = 0;
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
  private reconnectAttempt  = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private seqBuf       = createSeqBuffer();
  private gapTimer:    ReturnType<typeof setTimeout> | null = null;
  // Fires after RESUME if STREAM_END never arrives (chaos: server doesn't continue script)
  private replayTimer: ReturnType<typeof setTimeout> | null = null;

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

  constructor(dispatch: (action: AgentAction) => void) {
    this.dispatch = dispatch;
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
    // Reset seq tracking for the new turn BEFORE sending
    this.lastProcessedSeq = 0;
    this.seqBuf.reset();
    this.clearGapTimer();
    this.clearReplayTimer();
    this.replayCompleted = false;   // new turn — allow reconnects again
    this.flushTokenBatch();   // discard any stale batch
    this.dispatch({ type: 'USER_MESSAGE_SENT' });
    this.send({ type: 'USER_MESSAGE', content });
  }

  /** Called by useWebSocket to keep lastProcessedSeq in sync with the DOM. */
  updateLastProcessedSeq(seq: number): void {
    if (seq > this.lastProcessedSeq) this.lastProcessedSeq = seq;
  }

  destroy(): void {
    this.reconnectTimer  && clearTimeout(this.reconnectTimer);
    this.gapTimer        && clearTimeout(this.gapTimer);
    this.tokenBatchTimer && cancelAnimationFrame(this.tokenBatchTimer);
    this.replayTimer     && clearTimeout(this.replayTimer);
    this.isReconnecting  = false;   // prevent stale flag on next connect()
    this.isReplaying     = false;
    this.replayCompleted = false;
    this.sessionStarted  = false;
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
      this.send({ type: 'RESUME', last_seq: this.lastProcessedSeq });
      this.dispatch({ type: 'RECONNECT_SUCCESS' });
      this.isReconnecting   = false;
      this.reconnectAttempt = 0;
      this.isReplaying      = true;
      // Chaos: server replays history but never continues execution.
      // STREAM_END may never arrive — give up after REPLAY_TIMEOUT_MS.
      this.armReplayTimer();
    } else {
      this.isReconnecting = false;   // clean up any stale flag
      this.dispatch({ type: 'WS_OPEN' });
    }
  }

  private armReplayTimer(): void {
    this.replayTimer && clearTimeout(this.replayTimer);
    this.replayTimer = setTimeout(() => {
      this.replayTimer     = null;
      this.isReplaying     = false;
      this.replayCompleted = true;   // ← keeps onClose from reconnecting even after timer fires
      // Force-flush any buffered seq messages, then signal stream end.
      const flushed = this.seqBuf.flush();
      for (const m of flushed) this.dispatchMessage(m);
      this.flushTokenBatch();
      // Use a known stream_id sentinel — reducer treats any STREAM_END as finalising.
      this.dispatch({ type: 'STREAM_END', streamId: '__replay_timeout__' });
    }, REPLAY_TIMEOUT_MS);
  }

  private clearReplayTimer(): void {
    if (this.replayTimer !== null) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    this.isReplaying     = false;
    this.replayCompleted = false;
  }

  private onMessage(raw: string): void {
    const msg = unsafeJsonParse(raw) as ServerMessage;
    // 📥 SERVER → CLIENT (raw, before seq ordering)
    console.log('%c📥 SERVER→CLIENT', 'color:#60a5fa;font-weight:bold', `seq=${msg.seq} type=${msg.type}`, msg);
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

    if (this.isReplaying || this.replayCompleted) {
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
        // Send TOOL_ACK immediately (well within the 2 s window).
        // Suppress during replay — the server already received the ACK in the
        // original session; sending it again on the new connection causes
        // "unexpected TOOL_ACK" violations.
        if (!this.isReplaying) {
          const callId = msg.call_id;
          setTimeout(() => {
            console.log('%c✅ TOOL_ACK sent', 'color:#22c55e;font-weight:bold', `call_id=${callId}`);
            this.send({ type: 'TOOL_ACK', call_id: callId });
          }, 0);
        }
        break;
      }

      case 'TOOL_RESULT': {
        this.dispatch({
          type: 'TOOL_RESULT',
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
        this.clearReplayTimer();    // natural STREAM_END — cancel the replay timeout
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
