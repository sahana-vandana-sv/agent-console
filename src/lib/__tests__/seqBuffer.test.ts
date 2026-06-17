import { createSeqBuffer } from '../seqBuffer';
import type { ServerMessage } from '../../types/protocol';

// Server uses ++seq (pre-increment on a zero-initialised counter), so the
// first message of every turn always has seq=1. Tests use seq=1 as the
// base case — seq=0 never arrives naturally and will sit in the buffer forever.
function token(seq: number): ServerMessage {
  return { type: 'TOKEN', seq, text: `t${seq}`, stream_id: 's1' };
}

describe('seqBuffer', () => {
  it('returns empty array and hasPending=false when nothing added', () => {
    const buf = createSeqBuffer();
    expect(buf.hasPending()).toBe(false);
    expect(buf.flush()).toEqual([]);
  });

  it('flushes single element immediately when seq=1 (first server seq)', () => {
    const buf = createSeqBuffer();
    const out = buf.add(token(1));
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(1);
  });

  it('fully reversed sequence [4,3,2,1] flushes in order [1,2,3,4]', () => {
    const buf = createSeqBuffer();
    expect(buf.add(token(4))).toHaveLength(0);
    expect(buf.add(token(3))).toHaveLength(0);
    expect(buf.add(token(2))).toHaveLength(0);
    const out = buf.add(token(1));
    expect(out.map(m => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it('drops duplicate seq', () => {
    const buf = createSeqBuffer();
    buf.add(token(1));
    const out = buf.add(token(1));
    expect(out).toHaveLength(0);
  });

  it('flush() force-drains partial buffer in seq order (gap timeout case)', () => {
    const buf = createSeqBuffer();
    buf.add(token(3));
    buf.add(token(2));
    // seq=1 never arrives — gap timer would call flush() after 3s
    const flushed = buf.flush();
    expect(flushed.map(m => m.seq)).toEqual([2, 3]);
    expect(buf.hasPending()).toBe(false);
  });

  it('buffer of exactly 4 flushes correctly when contiguous anchor arrives', () => {
    const buf = createSeqBuffer();
    buf.add(token(4));
    buf.add(token(3));
    buf.add(token(2));
    const out = buf.add(token(1)); // seq=1 anchors the run → drains [1,2,3,4]
    expect(out.map(m => m.seq)).toEqual([1, 2, 3, 4]);
    expect(buf.hasPending()).toBe(false);
  });

  it('hasPending true only when there is a gap', () => {
    const buf = createSeqBuffer();
    buf.add(token(2)); // seq=2 arrives before seq=1 → gap
    expect(buf.hasPending()).toBe(true);
    buf.add(token(1)); // fills gap → drains both
    expect(buf.hasPending()).toBe(false);
  });

  it('gap timeout: subsequent add() after flush() stays consistent', () => {
    const buf = createSeqBuffer();
    buf.add(token(2));
    buf.add(token(1));
    buf.flush(); // force-drain [1,2]; nextExpected → 3
    const out = buf.add(token(3));
    expect(out.map(m => m.seq)).toEqual([3]);
  });

  it('reset clears all state for a new conversation turn', () => {
    const buf = createSeqBuffer();
    buf.add(token(1));
    buf.add(token(5)); // gap — seq 2,3,4 pending
    buf.reset();
    // After reset, seq=1 is fresh again (new turn starts from 1)
    const out = buf.add(token(1));
    expect(out).toHaveLength(1);
    expect(buf.hasPending()).toBe(false);
  });

  it('PING bypasses ordering and bypasses dedup (every PING gets through)', () => {
    const buf = createSeqBuffer();
    const ping: ServerMessage = { type: 'PING', seq: 5, challenge: 'abc' };
    // Arrives out of order — seq 1,2,3,4 not yet seen
    const out = buf.add(ping);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('PING');
    // Same ping seq again — PING bypasses dedup entirely (each must be PONGed)
    const out2 = buf.add(ping);
    expect(out2).toHaveLength(1);
  });

  it('TOOL_CALL bypasses ordering but IS deduped by seq', () => {
    const buf = createSeqBuffer();
    const tc: ServerMessage = {
      type: 'TOOL_CALL', seq: 3, call_id: 'c1',
      tool_name: 'myTool', args: {}, stream_id: 's1',
    };
    // Arrives out of order — dispatched immediately (ACK window constraint)
    const out = buf.add(tc);
    expect(out).toHaveLength(1);
    // Duplicate — must be dropped
    const out2 = buf.add(tc);
    expect(out2).toHaveLength(0);
  });

  it('TOOL_CALL bypass advances nextExpected so subsequent tokens are not stalled', () => {
    const buf = createSeqBuffer();
    buf.add(token(1));
    buf.add(token(2));
    // TOOL_CALL at seq=3 bypasses the buffer
    const tc: ServerMessage = {
      type: 'TOOL_CALL', seq: 3, call_id: 'c1',
      tool_name: 'search', args: {}, stream_id: 's1',
    };
    buf.add(tc);
    // seq=4 should drain immediately — not stall waiting for seq=3 in the buffer
    const out = buf.add(token(4));
    expect(out.map(m => m.seq)).toEqual([4]);
    expect(buf.hasPending()).toBe(false);
  });

  it('STREAM_END bypasses dedup so replayed STREAM_END is never silently dropped', () => {
    const buf = createSeqBuffer();
    // Simulate original connection: tokens arrive and STREAM_END is processed
    buf.add(token(1));
    buf.add(token(2));
    const se: ServerMessage = { type: 'STREAM_END', seq: 3, stream_id: 's1' };
    buf.add(se);   // seq=3 added to seen

    // Reconnect: trimAfter(3) — STREAM_END seq=3 is <= lastRendered so it stays in seen
    buf.trimAfter(3);

    // Server replays the STREAM_END — must NOT be dropped by dedup
    const out = buf.add(se);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('STREAM_END');
  });

  it('trimAfter evicts seen entries above lastRendered and resets nextExpected', () => {
    const buf = createSeqBuffer();
    buf.add(token(1)); // rendered — committed
    buf.add(token(2)); // received but not yet rendered (mid rAF window)
    buf.add(token(3)); // received but not yet rendered

    // Simulate: connection dropped with lastProcessedSeq=1 (only seq=1 committed)
    buf.trimAfter(1);

    // seq=2 and seq=3 evicted from seen → server replay will pass through
    // nextExpected reset to 2
    const out = buf.add(token(2)); // replayed seq=2 should NOT be dropped
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(2);
  });
});
