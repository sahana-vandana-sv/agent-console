import { createSeqBuffer } from '../seqBuffer';
import type { ServerMessage } from '../../types/protocol';

function token(seq: number): ServerMessage {
  return { type: 'TOKEN', seq, text: `t${seq}`, stream_id: 's1' };
}

describe('seqBuffer', () => {
  it('returns empty array when nothing added', () => {
    const buf = createSeqBuffer();
    expect(buf.hasPending()).toBe(false);
    expect(buf.flush()).toEqual([]);
  });

  it('flushes single element immediately when seq=0 (contiguous from start)', () => {
    const buf = createSeqBuffer();
    const out = buf.add(token(0));
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(0);
  });

  it('fully reversed sequence flushes in order', () => {
    const buf = createSeqBuffer();
    expect(buf.add(token(3))).toHaveLength(0);
    expect(buf.add(token(2))).toHaveLength(0);
    expect(buf.add(token(1))).toHaveLength(0);
    const out = buf.add(token(0));
    expect(out.map(m => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it('drops duplicate seq', () => {
    const buf = createSeqBuffer();
    buf.add(token(0));
    const out = buf.add(token(0));
    expect(out).toHaveLength(0);
  });

  it('flush() force-drains partial buffer in seq order', () => {
    const buf = createSeqBuffer();
    buf.add(token(2));
    buf.add(token(1));
    // seq 0 never arrives
    const flushed = buf.flush();
    expect(flushed.map(m => m.seq)).toEqual([1, 2]);
    expect(buf.hasPending()).toBe(false);
  });

  it('buffer of exactly 4 flushes correctly when contiguous arrives', () => {
    const buf = createSeqBuffer();
    buf.add(token(3));
    buf.add(token(2));
    buf.add(token(1));
    const out = buf.add(token(0));
    expect(out.map(m => m.seq)).toEqual([0, 1, 2, 3]);
    expect(buf.hasPending()).toBe(false);
  });

  it('hasPending true only when there is a gap', () => {
    const buf = createSeqBuffer();
    buf.add(token(1));
    expect(buf.hasPending()).toBe(true);
    buf.add(token(0));
    expect(buf.hasPending()).toBe(false);
  });

  it('reset clears all state for new turn', () => {
    const buf = createSeqBuffer();
    buf.add(token(0));
    buf.add(token(5)); // gap
    buf.reset();
    // After reset, seq 0 is fresh again
    const out = buf.add(token(0));
    expect(out).toHaveLength(1);
    expect(buf.hasPending()).toBe(false);
  });

  it('PING bypasses ordering and dedup', () => {
    const buf = createSeqBuffer();
    const ping: ServerMessage = { type: 'PING', seq: 5, challenge: 'abc' };
    // Arrives out of order (seq 0,1,2 not yet seen)
    const out = buf.add(ping);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('PING');
    // Same ping seq again — PING bypasses dedup entirely
    const out2 = buf.add(ping);
    expect(out2).toHaveLength(1);
  });

  it('TOOL_CALL bypasses ordering but is deduped by seq', () => {
    const buf = createSeqBuffer();
    const tc: ServerMessage = {
      type: 'TOOL_CALL', seq: 3, call_id: 'c1',
      tool_name: 'myTool', args: {}, stream_id: 's1',
    };
    // Arrives out of order
    const out = buf.add(tc);
    expect(out).toHaveLength(1);
    // Duplicate — should be dropped
    const out2 = buf.add(tc);
    expect(out2).toHaveLength(0);
  });

  it('subsequent add() after flush() stays consistent', () => {
    const buf = createSeqBuffer();
    buf.add(token(2));
    buf.add(token(1));
    buf.flush(); // drains 1,2; nextExpected becomes 3
    const out = buf.add(token(3));
    expect(out.map(m => m.seq)).toEqual([3]);
  });
});
