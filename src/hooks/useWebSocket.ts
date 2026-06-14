'use client';

import { useEffect, useRef, useCallback } from 'react';
import { AgentProtocol } from '../lib/AgentProtocol';
import { useAgentReducer } from './useAgentReducer';
import type { StreamState } from '../types/state';

export interface UseWebSocketReturn {
  state: StreamState;
  sendMessage: (content: string) => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const [state, dispatch] = useAgentReducer();
  const protocolRef = useRef<AgentProtocol | null>(null);

  // This ref is written synchronously on every render (before useEffect runs),
  // so AgentProtocol always reads the latest committed seq — even if ws.onclose
  // fires before the post-render useEffect has had a chance to call
  // updateLastProcessedSeq(). Without this, RESUME { last_seq } can be stale.
  const lastProcessedSeqRef = useRef<number>(0);
  lastProcessedSeqRef.current = state.lastProcessedSeq;

  useEffect(() => {
    const protocol = new AgentProtocol(dispatch, lastProcessedSeqRef);
    protocolRef.current = protocol;
    protocol.connect();
    return () => protocol.destroy();
  // dispatch is stable (useReducer), so this runs only on mount/unmount.
  // lastProcessedSeqRef is a stable ref object — no dep needed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remove the old useEffect-based sync — the ref above replaces it.

  const sendMessage = useCallback((content: string) => {
    protocolRef.current?.sendUserMessage(content);
  }, []);

  return { state, sendMessage };
}
