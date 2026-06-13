import type { AgentAction } from '../../types/state';

// ─── WebSocket mock ─────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDispatch() {
  const actions: AgentAction[] = [];
  return { dispatch: (a: AgentAction) => actions.push(a), actions };
}

function serverMsg(obj: object): string {
  return JSON.stringify(obj);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AgentProtocol', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    lastWs = null;
    MockWebSocket.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentProtocol } = require('../AgentProtocol');
    const { dispatch, actions } = makeDispatch();
    const proto = new AgentProtocol(dispatch);
    proto.connect();
    lastWs!.onopen?.();
    return { proto, actions };
  }

  it('sends PONG immediately on PING', () => {
    const { } = setup();
    lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 0, challenge: 'abc123' }) });
    jest.runAllTimers();
    const pongs = lastWs!.sentMessages.map(m => JSON.parse(m)).filter((m: {type:string}) => m.type === 'PONG');
    expect(pongs).toHaveLength(1);
    expect(pongs[0].echo).toBe('abc123');
  });

  it('PONG echoes challenge verbatim', () => {
    setup();
    const challenge = 'xYz_789';
    lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 1, challenge }) });
    jest.runAllTimers();
    const pong = lastWs!.sentMessages.map(m => JSON.parse(m)).find((m: {type:string}) => m.type === 'PONG');
    expect(pong?.echo).toBe(challenge);
  });

  it('empty challenge PING → PONG with echo: "" (no crash)', () => {
    setup();
    expect(() => {
      lastWs!.onmessage?.({ data: serverMsg({ type: 'PING', seq: 2, challenge: '' }) });
    }).not.toThrow();
    jest.runAllTimers();
    const pong = lastWs!.sentMessages.map(m => JSON.parse(m)).find((m: {type:string}) => m.type === 'PONG');
    expect(pong).toBeDefined();
    expect(pong?.echo).toBe('');
  });

  it('TOOL_ACK sent within 2s of TOOL_CALL (fires via setTimeout 0)', () => {
    const { proto } = setup();
    proto.sendUserMessage('hello');
    lastWs!.onmessage?.({ data: serverMsg({
      type: 'TOOL_CALL', seq: 1, call_id: 'call_42',
      tool_name: 'search', args: {}, stream_id: 'stream_1',
    }) });
    jest.runAllTimers();
    const acks = lastWs!.sentMessages.map(m => JSON.parse(m)).filter((m: {type:string}) => m.type === 'TOOL_ACK');
    expect(acks).toHaveLength(1);
    expect(acks[0].call_id).toBe('call_42');
  });

  it('RESUME is first message sent after reconnect', () => {
    const { proto } = setup();
    proto.sendUserMessage('hello');
    // Simulate hard drop
    lastWs!.terminate();
    jest.runAllTimers(); // fires backoff timer → connect() → new MockWs
    // New connection opens
    lastWs!.onopen?.();
    const sent = lastWs!.sentMessages.map(m => JSON.parse(m));
    expect(sent[0]?.type).toBe('RESUME');
  });

  it('lastProcessedSeq resets to 0 on new USER_MESSAGE', () => {
    const { proto, actions } = setup();
    proto.sendUserMessage('hello');
    // Advance seq through some tokens
    lastWs!.onmessage?.({ data: serverMsg({ type: 'TOKEN', seq: 0, text: 'Hi', stream_id: 's' }) });
    lastWs!.onmessage?.({ data: serverMsg({ type: 'TOKEN', seq: 1, text: '!', stream_id: 's' }) });
    jest.runAllTimers();
    // Send new message — seq resets
    proto.sendUserMessage('world');
    const userMsgActions = actions.filter(a => a.type === 'USER_MESSAGE_SENT');
    expect(userMsgActions.length).toBeGreaterThanOrEqual(2);
    // seq 0 should be fresh for the new turn (not deduped)
    lastWs!.onmessage?.({ data: serverMsg({ type: 'TOKEN', seq: 0, text: 'New', stream_id: 's2' }) });
    jest.runAllTimers();
    const batches = actions.filter(a => a.type === 'TOKENS_BATCH');
    expect(batches.length).toBeGreaterThan(0);
  });

  it('TOOL_ACK not sent for replayed TOOL_CALL during RESUME', () => {
    const { proto } = setup();
    proto.sendUserMessage('hello');
    // Hard drop → reconnect
    lastWs!.terminate();
    jest.runAllTimers();
    lastWs!.onopen?.(); // reconnect → RESUME sent, isReplaying = true
    // Server replays a TOOL_CALL
    lastWs!.onmessage?.({ data: serverMsg({
      type: 'TOOL_CALL', seq: 1, call_id: 'call_replay',
      tool_name: 'search', args: {}, stream_id: 's',
    }) });
    jest.runAllTimers();
    const acks = lastWs!.sentMessages.map(m => JSON.parse(m)).filter((m: {type:string}) => m.type === 'TOOL_ACK');
    expect(acks).toHaveLength(0);
  });
});
