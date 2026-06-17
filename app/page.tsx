'use client';

import { useCallback, useState, useRef, useEffect } from 'react';
import { useWebSocket } from '../src/hooks/useWebSocket';
import { StreamingChat } from '../src/components/StreamingChat';
import { TraceTimeline } from '../src/components/TraceTimeline';
import { ContextInspector } from '../src/components/ContextInspector';
import { ConnectionStatus } from '../src/components/ConnectionStatus';

export default function Home() {
  const { state, sendMessage } = useWebSocket();
  const [input, setInput]           = useState('');
  const [traceOpen, setTraceOpen]   = useState(true);
  const [contextOpen, setContextOpen] = useState(true);

  /**
   * Bidirectional highlight.
   * - Timeline click → sets this → StreamingChat highlights + scrolls to the segment
   * - Chat click     → sets this → TraceTimeline highlights + scrolls to the row
   */
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.segments]);

  // Clear highlight on new message
  useEffect(() => {
    setActiveSegmentId(null);
  }, [state.segments.length === 0]);   // resets when segments are cleared (new turn)

  const handleSegmentFocus = useCallback((segmentId: string | null) => {
    setActiveSegmentId((prev) => (prev === segmentId ? null : segmentId));
  }, []);

  // Stable callbacks — must not be inline arrows.
  // ContextInspector and TraceTimeline are memo'd; an inline () => setState(...)
  // creates a new function reference on every parent render, defeating memo and
  // causing the 550KB JsonTree to re-render on every token batch.
  const handleToggleTrace   = useCallback(() => setTraceOpen(v => !v), []);
  const handleToggleContext = useCallback(() => setContextOpen(v => !v), []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content) return;
    setInput('');
    setActiveSegmentId(null);
    sendMessage(content);
  }

  return (
    <div className="flex h-screen bg-white dark:bg-zinc-950">
      {/* Floating reconnect toast — fixed so it never shifts layout */}
      <ConnectionStatus phase={state.phase} reconnectAttempt={state.reconnectAttempt} />

      {/* Main chat column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h1 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Agent Console</h1>
          <p className="text-xs text-zinc-400">{state.phase}</p>
        </header>

        <div className="flex-1 overflow-y-auto">
          <StreamingChat
            segments={state.segments}
            phase={state.phase}
            activeSegmentId={activeSegmentId}
            onSegmentFocus={handleSegmentFocus}
          />
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSubmit} className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Try: hello, report, analyze, lookup, large"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={
                !input.trim() ||
                ['STREAMING', 'BUFFERING', 'TOOL_PENDING'].includes(state.phase)
              }
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {/* Trace timeline */}
      <div className={`flex h-full shrink-0 flex-col overflow-hidden transition-all ${traceOpen ? 'w-72' : 'w-10'}`}>
        <TraceTimeline
          events={state.traceEvents}
          segments={state.segments}
          isOpen={traceOpen}
          onToggle={handleToggleTrace}
          activeSegmentId={activeSegmentId}
          onSegmentFocus={handleSegmentFocus}
        />
      </div>

      {/* Context inspector */}
      <div className={`flex h-full shrink-0 flex-col overflow-hidden transition-all ${contextOpen ? 'w-80' : 'w-10'}`}>
        <ContextInspector
          contextSnapshots={state.contextSnapshots}
          isOpen={contextOpen}
          onToggle={handleToggleContext}
        />
      </div>
    </div>
  );
}
