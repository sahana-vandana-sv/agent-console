'use client';

interface Props {
  typeFilter: string;
  searchFilter: string;
  onTypeChange: (v: string) => void;
  onSearchChange: (v: string) => void;
}

const EVENT_TYPES = [
  'ALL',
  'TOKEN',
  'TOOL_CALL',
  'TOOL_RESULT',
  'CONTEXT_SNAPSHOT',
  'PING/PONG',
  'STREAM_END',
  'ERROR',
];

export function FilterBar({ typeFilter, searchFilter, onTypeChange, onSearchChange }: Props) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
      <div className="flex flex-wrap gap-1">
        {EVENT_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => onTypeChange(t)}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              typeFilter === t
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="Search content…"
        value={searchFilter}
        onChange={(e) => onSearchChange(e.target.value)}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
      />
    </div>
  );
}
