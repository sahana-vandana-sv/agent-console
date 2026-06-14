import type { DiffResult } from '../../lib/jsonDiff';

interface Props {
  diff: DiffResult;
}

/** Render a value inline — objects/arrays summarised, strings truncated. */
function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).length} keys}`;
  return String(v);
}

export function DiffView({ diff }: Props) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return <p className="px-3 py-2 text-xs text-zinc-400">No changes</p>;
  }

  return (
    <div className="border-b border-zinc-100 dark:border-zinc-800">
      <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Changes from previous snapshot
      </p>
    <div className="px-3 pb-2 pt-1 font-mono text-xs">
      {diff.added.map((e) => (
        <div key={e.key} className="flex gap-1 text-green-700 dark:text-green-400">
          <span className="shrink-0">+</span>
          <span className="font-semibold">{e.key}</span>
          <span className="text-green-600/70 dark:text-green-500/70">: {fmtValue(e.newValue)}</span>
        </div>
      ))}
      {diff.removed.map((e) => (
        <div key={e.key} className="flex gap-1 text-red-600 dark:text-red-400">
          <span className="shrink-0">−</span>
          <span className="font-semibold">{e.key}</span>
          <span className="text-red-500/70 dark:text-red-400/70">: {fmtValue(e.oldValue)}</span>
        </div>
      ))}
      {diff.changed.map((e) => (
        <div key={e.key} className="flex gap-1 text-amber-600 dark:text-amber-400">
          <span className="shrink-0">~</span>
          <span className="font-semibold">{e.key}</span>
          <span className="text-amber-500/70 dark:text-amber-400/70">
            : {fmtValue(e.oldValue)} → {fmtValue(e.newValue)}
          </span>
        </div>
      ))}
    </div>
    </div>
  );
}
