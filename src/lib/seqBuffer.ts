import type { ServerMessage } from '../types/protocol';

// Pure ordering buffer — no timers, no React.
// AgentProtocol owns the 3 s gap timer and calls flush() on expiry.
//
// Server seq starts at 1 per turn (++seq on a zero-initialised counter).
// Call reset() before each new USER_MESSAGE turn.

export interface SeqBuffer {
  /** Add a message. Returns in-order messages ready to dispatch (may be empty). */
  add(msg: ServerMessage): ServerMessage[];
  /** Force-drain all buffered messages in seq order (gap timeout / disconnect). */
  flush(): ServerMessage[];
  /** Reset to seq=0 for a new conversation turn. */
  reset(): void;
  /** True when there are messages waiting on a gap. */
  hasPending(): boolean;
  /**
   * Evict from `seen` and `buffer` any entries with seq > lastRendered, and
   * reset nextExpected to lastRendered + 1.
   *
   * Called on reconnect before sending RESUME. The `seen` Set can run ahead of
   * lastProcessedSeq when messages arrived and were dedup-marked but the
   * connection dropped before the reducer committed them (e.g. mid token-batch
   * or inside the 16ms rAF accumulation window). Without this trim, the server's
   * replay of those seqs hits `seen.has(seq) → true` and is dropped silently,
   * leaving a permanent gap in the rendered output.
   */
  trimAfter(lastRendered: number): void;
}

export function createSeqBuffer(): SeqBuffer {
  const buffer = new Map<number, ServerMessage>();
  const seen   = new Set<number>();
  // Server uses ++seq (pre-increment starting from 0), so the first message
// always has seq=1. Starting nextExpected at 0 would stall the buffer forever
// waiting for a seq=0 that never arrives. Start at 1 to match the server.
let nextExpected = 1;

  function drainContiguous(): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (buffer.has(nextExpected)) {
      out.push(buffer.get(nextExpected)!);
      buffer.delete(nextExpected);
      nextExpected++;
    }
    return out;
  }

  return {
    add(msg: ServerMessage): ServerMessage[] {
      // PING, ERROR, and STREAM_END bypass ordering and dedup — deliver immediately.
      // STREAM_END must bypass dedup because its seq is already in `seen` from the
      // original connection. trimAfter() only evicts seqs > lastRendered, so a
      // STREAM_END that was processed before the drop keeps its seq in `seen` and
      // would be silently dropped during replay — forcing the 9500ms idle timer as
      // the only path to end the stream. Bypassing dedup ensures the replayed
      // STREAM_END always reaches dispatchMessage(), which is idempotent.
      if (msg.type === 'PING' || msg.type === 'ERROR' || msg.type === 'STREAM_END') return [msg];

      // TOOL_CALL bypasses ordering (still deduped by seq) so TOOL_ACK can be
      // sent within the 2s window regardless of seq gaps or latency spikes.
      // Holding TOOL_CALL in the buffer adds gap-timer delay (up to 3s) on top
      // of any network latency, which together can exceed the 2s ACK window.
      if (msg.type === 'TOOL_CALL') {
        if (seen.has(msg.seq)) return [];   // duplicate — drop silently
        seen.add(msg.seq);
        // Advance nextExpected so subsequent messages aren't stalled.
        // Without this, seq=N TOOL_CALL bypasses the buffer but nextExpected
        // stays at N — every message after it (seq=N+1, N+2…) gets held
        // waiting for an N that will never appear in the buffer, triggering
        // the 3s gap timer in normal mode.
        if (msg.seq >= nextExpected) nextExpected = msg.seq + 1;
        return [msg];
      }

      const { seq } = msg;
      if (seen.has(seq)) return [];   // duplicate — drop silently
      seen.add(seq);

      buffer.set(seq, msg);
      return drainContiguous();
    },

    flush(): ServerMessage[] {
      const sorted = Array.from(buffer.entries())
        .sort(([a], [b]) => a - b)
        .map(([, m]) => m);
      buffer.clear();
      // Advance nextExpected so subsequent add() calls remain consistent
      if (sorted.length > 0) {
        nextExpected = sorted[sorted.length - 1]!.seq + 1;
      }
      return sorted;
    },

    reset(): void {
      buffer.clear();
      seen.clear();
      nextExpected = 1;   // server ++seq starts at 1, not 0
    },

    hasPending(): boolean {
      return buffer.size > 0;
    },

    trimAfter(lastRendered: number): void {
      // Remove from `seen` any seq that was received but not yet committed to
      // the reducer (seq > lastRendered). The server will replay those seqs and
      // they must pass through dedup rather than being silently dropped.
      for (const s of seen) {
        if (s > lastRendered) seen.delete(s);
      }
      // Discard any buffered (held, not yet dispatched) messages beyond lastRendered.
      for (const [s] of buffer) {
        if (s > lastRendered) buffer.delete(s);
      }
      // Reset the drain pointer so the buffer waits for lastRendered+1 next.
      nextExpected = lastRendered + 1;
    },
  };
}
