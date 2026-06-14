'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectionPhase } from '../types/state';

interface Props {
  phase: ConnectionPhase;
  reconnectAttempt: number;
}

const BACKOFF_STEPS = [500, 1000, 2000, 4000, 10000];

export function ConnectionStatus({ phase, reconnectAttempt }: Props) {
  const [countdown, setCountdown] = useState(0);

  // Create a stable portal container synchronously on first client render —
  // avoids the mounted-state race where a useState(false)→true cycle delays
  // visibility by one render, which can be longer than a fast reconnect.
  const portalRef = useRef<HTMLDivElement | null>(null);
  if (typeof document !== 'undefined' && !portalRef.current) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    portalRef.current = el;
  }

  // Remove the portal container when the component unmounts
  useEffect(() => {
    return () => {
      if (portalRef.current) {
        document.body.removeChild(portalRef.current);
        portalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'RECONNECTING') { setCountdown(0); return; }
    const ms = BACKOFF_STEPS[Math.min(reconnectAttempt - 1, BACKOFF_STEPS.length - 1)] ?? 500;
    const endsAt = Date.now() + ms;
    setCountdown(Math.ceil(ms / 1000));
    const id = setInterval(() => {
      const rem = endsAt - Date.now();
      if (rem <= 0) { clearInterval(id); setCountdown(0); }
      else setCountdown(Math.ceil(rem / 1000));
    }, 200);
    return () => clearInterval(id);
  }, [phase, reconnectAttempt]);

  if (!portalRef.current || (phase !== 'RECONNECTING' && phase !== 'RESUMING')) return null;

  return createPortal(
    <div
      role="status"
      // Inline style for position/z-index — avoids any Tailwind purge or
      // stacking-context interference from ancestor flex/overflow containers.
      style={{ position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 9999 }}
      className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-md dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
    >
      <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
      {phase === 'RECONNECTING'
        ? `Connection lost — reconnecting${countdown > 0 ? ` in ${countdown}s` : '…'} (attempt ${reconnectAttempt})`
        : 'Reconnected — replaying session…'}
    </div>,
    portalRef.current,
  );
}
