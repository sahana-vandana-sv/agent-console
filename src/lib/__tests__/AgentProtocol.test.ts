import type { AgentAction } from '../../types/state';

// ─── Browser API stubs (not available in Node/Jest) ──────────────────────────

// requestAnimationFrame: flush synchronously via setTimeout(0) so jest.runAllTimers()
// drives token batches in tests without needing a real browser paint cycle.
global.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  return setTimeout(() => cb(performance.now()), 0) as unknown as number;
};
global.cancelAnimationFrame = (id: number) => clearTimeout(id);

// ─── WebSocket mock ───────────────────────────────────────────────────────────

interface MockWs {
  readyState: number;
  sentMessages: string[];
  onopen:    (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror:   (() => void) | null;
  onclose:   (() => void) | null;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

let lastWs: MockWs | null = null;

function makeWsMock(): MockWs {
  const ws: MockWs = {
    readyState: 1, // OPEN
    sentMessages: [],
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(data: string) { this.sentMessages.push(data); },
    close() { this.readyState = 3; },
    terminate() { this.readyState = 3; this.onerror?.(); this.onclose?.(); },
  };
  lastWs = ws;
  return ws;
}

const MockWebSocket = jest.fn().mockImplementation(() => makeWsMock());
(MockWebSocket as unknown as Record<string, number>).OPEN = 1;
global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDispatch() {
  const actions: AgentAction[] = [];
  return { dispatch: (a: AgentAction) => actions.push(a), actions };
}

function serverMsg(obj: object): string {
  return JSON.stringify(obj);
}

// ─── Test setup ───────────────────────────────────────────────────────────────

describe('AgentProtocol', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    lastWs = null;
    MockWebSocket.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup(lastProcessedSeq = 0) {
    // Fresh require each test to avoid module-level state leaking between tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentProtocol } = require('../AgentProtocol');
    const { dispatch, actions } = makeDispatch();
    // lastProcessedSeqRef mirrors what useWebSocket writes synchronously on render.
    const lastProcessedSeqRef = { current: lastProcessedSeq };
    const proto = new AgentProtocol(dispatch, lastProcessedSeqRef);
    proto.connect();
    lastWs!.onopen?.();
    return { proto, actions, lastProcessedSeqRef };
  }

  // ── PING / PONG ─────────────────────────────────────────────────────────────

  it('sends PONG immediately on PING', () => {
    setup();
    lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 0, challenge: 'abc123' }) });
    jest.runAllTimers();
    const pongs = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .filter((m: { type: string }) => m.type === 'PONG');
    expect(pongs).toHaveLength(1);
    expect(pongs[0].echo).toBe('abc123');
  });

  it('PONG echoes challenge verbatim', () => {
    setup();
    const challenge = 'xYz_789';
    lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 1, challenge }) });
    jest.runAllTimers();
    const pong = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .find((m: { type: string }) => m.type === 'PONG');
    expect(pong?.echo).toBe(challenge);
  });

  it('empty challenge PING (corrupt) → PONG with echo: "" — no crash', () => {
    setup();
    expect(() => {
      lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 2, challenge: '' }) });
    }).not.toThrow();
    jest.runAllTimers();
    const pong = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .find((m: { type: string }) => m.type === 'PONG');
    expect(pong).toBeDefined();
    expect(pong?.echo).toBe('');
  });

  // ── TOOL_ACK ────────────────────────────────────────────────────────────────

  it('TOOL_ACK sent synchronously on TOOL_CALL (no timer needed)', () => {
    const { proto } = setup();
    proto.sendUserMessage('hello');
    lastWs!.onmessage?.({ data: serverMsg({
      type: 'TOOL_CALL', seq: 1, call_id: 'call_42',
      tool_name: 'search', args: {}, stream_id: 'stream_1',
    }) });
    // ACK is now synchronous — no timer needed. Verify without advancing timers.
    const acks = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .filter((m: { type: string }) => m.type === 'TOOL_ACK');
    expect(acks).toHaveLength(1);
    expect(acks[0].call_id).toBe('call_42');
  });

  // ── RESUME ──────────────────────────────────────────────────────────────────

  it('RESUME is first message sent after reconnect', () => {
    const { proto } = setup();
    proto.sendUserMessage('hello');
    // Simulate hard drop (ws.terminate fires onerror then onclose)
    lastWs!.terminate();
    jest.runAllTimers(); // fires backoff timer → connect() → new MockWs
    lastWs!.onopen?.();
    const sent = lastWs!.sentMessages.map(m => JSON.parse(m));
    expect(sent[0]?.type).toBe('RESUME');
  });

  it('RESUME carries the last DOM-committed seq, not the last socket-received seq', () => {
    // Simulate: seq=5 committed to DOM (lastProcessedSeq=5),
    // seq=6 received but not yet rendered when connection drops.
    const { proto } = setup(5); // lastProcessedSeqRef.current = 5
    proto.sendUserMessage('hello');
    lastWs!.terminate();
    jest.runAllTimers();
    lastWs!.onopen?.();
    const resume = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .find((m: { type: string }) => m.type === 'RESUME');
    expect(resume?.last_seq).toBe(5);
  });

  // ── Replay / RESUME edge cases ──────────────────────────────────────────────

  it('TOOL_ACK sent for replayed TOOL_CALL with seq > resumeLastSeq (ACK was never delivered)', () => {
    // resumeLastSeq = 0 (no seqs committed before drop).
    // Server replays TOOL_CALL seq=1 — the original ACK was never received by
    // the server (connection dropped before it arrived). Client MUST send ACK.
    const { proto } = setup(0);
    proto.sendUserMessage('hello');
    lastWs!.terminate();
    jest.runAllTimers();
    lastWs!.onopen?.(); // reconnect → RESUME { last_seq: 0 }, isReplaying = true

    lastWs!.onmessage?.({ data: serverMsg({
      type: 'TOOL_CALL', seq: 1, call_id: 'call_replay',
      tool_name: 'search', args: {}, stream_id: 's',
    }) });
    jest.runAllTimers();

    const acks = lastWs!.sentMessages
      .map(m => JSON.parse(m))
      .filter((m: { type: string }) => m.type === 'TOOL_ACK');
    // seq=1 > resumeLastSeq=0 → original ACK was never delivered → send it now
    expect(acks).toHaveLength(1);
    expect(acks[0].call_id).toBe('call_replay');
  });

  // ── lastProcessedSeq reset ──────────────────────────────────────────────────

  it('lastProcessedSeq resets to 0 on new USER_MESSAGE (new turn)', () => {
    const { proto, actions } = setup();
    proto.sendUserMessage('first');
    // Advance seq through some tokens
    lastWs!.onmessage?.({ data: serverMsg({ type: 'TOKEN', seq: 1, text: 'Hi', stream_id: 's' }) });
    jest.runAllTimers();
    // Send new message — seqBuf resets, USER_MESSAGE_SENT dispatched
    proto.sendUserMessage('second');
    const userMsgActions = actions.filter(a => a.type === 'USER_MESSAGE_SENT');
    expect(userMsgActions.length).toBeGreaterThanOrEqual(2);
    // seq=1 should be fresh for the new turn (dedup Set cleared by reset())
    lastWs!.onmessage?.({ data: serverMsg({ type: 'TOKEN', seq: 1, text: 'New', stream_id: 's2' }) });
    jest.runAllTimers();
    const batches = actions.filter(a => a.type === 'TOKENS_BATCH');
    expect(batches.length).toBeGreaterThan(0);
  });
});
