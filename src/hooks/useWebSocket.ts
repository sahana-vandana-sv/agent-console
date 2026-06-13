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

  useEffect(() => {
    const protocol = new AgentProtocol(dispatch);
    protocolRef.current = protocol;
    protocol.connect();
    return () => protocol.destroy();
  // dispatch is stable (useReducer), so this runs only on mount/unmount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep protocol's lastProcessedSeq in sync with the reducer's view.
  // This is the value sent in RESUME after a reconnect.
  useEffect(() => {
    protocolRef.current?.updateLastProcessedSeq(state.lastProcessedSeq);
  }, [state.lastProcessedSeq]);

  const sendMessage = useCallback((content: string) => {
    protocolRef.current?.sendUserMessage(content);
  }, []);

  return { state, sendMessage };
}
