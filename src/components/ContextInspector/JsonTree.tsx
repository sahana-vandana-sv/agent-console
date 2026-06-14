'use client';

import { startTransition, useState } from 'react';

interface Props {
  data: Record<string, unknown>;
  highlightKeys?: Set<string>;
}

export function JsonTree({ data, highlightKeys }: Props) {
  // Top-level keys rendered, children collapsed by default (lazy expand)
  // TODO: virtual scroll for 550KB payloads
  const keys = Object.keys(data);

  return (
    <div className="font-mono text-xs">
      {keys.map((key) => (
        <JsonNode
          key={key}
          nodeKey={key}
          value={data[key]}
          highlighted={highlightKeys?.has(key) ?? false}
        />
      ))}
    </div>
  );
}

function JsonNode({ nodeKey, value, highlighted }: {
  nodeKey: string;
  value: unknown;
  highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isObject = value !== null && typeof value === 'object';

  return (
    <div className={`py-0.5 ${highlighted ? 'bg-yellow-100 dark:bg-yellow-900/30' : ''}`}>
      <button
        className="flex w-full items-start gap-1 text-left"
        onClick={() => isObject && startTransition(() => setExpanded((v) => !v))}
      >
        <span className="text-violet-600 dark:text-violet-400">{nodeKey}</span>
        <span className="text-zinc-400">:</span>
        {isObject ? (
          <span className="text-zinc-400">{expanded ? '▾' : '▸'} {Array.isArray(value) ? `[${(value as unknown[]).length}]` : '{…}'}</span>
        ) : (
          <span className="text-green-700 dark:text-green-400">{JSON.stringify(value)}</span>
        )}
      </button>
      {isObject && expanded && (
        <div className="ml-4 border-l border-zinc-200 pl-2 dark:border-zinc-700">
          {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
            <JsonNode key={k} nodeKey={k} value={v} highlighted={false} />
          ))}
        </div>
      )}
    </div>
  );
}
