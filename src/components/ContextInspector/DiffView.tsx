import type { DiffResult } from '../../lib/jsonDiff';

interface Props {
  diff: DiffResult;
}

export function DiffView({ diff }: Props) {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return <p className="px-3 py-2 text-xs text-zinc-400">No changes</p>;
  }

  return (
    <div className="space-y-0.5 px-3 py-2 font-mono text-xs">
      {diff.added.map((e) => (
        <div key={e.key} className="text-green-700 dark:text-green-400">
          + {e.key}
        </div>
      ))}
      {diff.removed.map((e) => (
        <div key={e.key} className="text-red-600 dark:text-red-400">
          - {e.key}
        </div>
      ))}
      {diff.changed.map((e) => (
        <div key={e.key} className="text-amber-600 dark:text-amber-400">
          ~ {e.key}
        </div>
      ))}
    </div>
  );
}
