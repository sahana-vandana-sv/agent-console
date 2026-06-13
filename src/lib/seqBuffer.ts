import type { ServerMessage } from '../types/protocol';

// Pure ordering buffer — no timers, no React.
// AgentProtocol owns the 3 s gap timer and calls flush() on expiry.
//
// seq resets to 0 on each USER_MESSAGE turn; call reset() before the new turn.

export interface SeqBuffer {
  /** Add a message. Returns in-order messages ready to dispatch (may be empty). */
  add(msg: ServerMessage): ServerMessage[];
  /** Force-drain all buffered messages in seq order (gap timeout / disconnect). */
  flush(): ServerMessage[];
  /** Reset to seq=0 for a new conversation turn. */
  reset(): void;
  /** True when there are messages waiting on a gap. */
  hasPending(): boolean;
}

export function createSeqBuffer(): SeqBuffer {
  const buffer = new Map<number, ServerMessage>();
  const seen   = new Set<number>();
  let nextExpected = 0;

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
      // PING and ERROR bypass ordering entirely — deliver immediately, no dedup.
      if (msg.type === 'PING' || msg.type === 'ERROR') return [msg];

      // TOOL_CALL bypasses ordering (still deduped by seq) so TOOL_ACK can be
      // sent within the 2s window regardless of seq gaps or latency spikes.
      // Holding TOOL_CALL in the buffer adds gap-timer delay (up to 3s) on top
      // of any network latency, which together can exceed the 2s ACK window.
      if (msg.type === 'TOOL_CALL') {
        if (seen.has(msg.seq)) return [];   // duplicate — drop silently
        seen.add(msg.seq);
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
      nextExpected = 0;
    },

    hasPending(): boolean {
      return buffer.size > 0;
    },
  };
}
