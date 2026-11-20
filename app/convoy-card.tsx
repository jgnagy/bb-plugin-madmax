// bb-plugin-madmax — one convoy (epic) with its beads laid across the pipeline.
import type { TownConvoy } from "./types";
import { KanbanColumns } from "./board";

export function ConvoyCard({ convoy }: { convoy: TownConvoy }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <p className="min-w-0 truncate font-medium">{convoy.title}</p>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{convoy.id}</span>
      </div>
      {convoy.beads.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No beads yet.</p>
      ) : (
        <KanbanColumns beads={convoy.beads} />
      )}
    </div>
  );
}
