// bb-plugin-madmax — the Town Hall page: problems first, then the pipeline
// (or convoys), a roster, and an activity feed. Each bead card carries the
// worker controls to steer, interrupt, or end a polecat.
import { useCallback, useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { BoardBead, rpcContract } from "../server";
import { ConvoyCard } from "./convoy-card";
import { TownOnboarding } from "./onboarding";
import { TownHallData } from "./types";
import { cn, timeAgo } from "./utils";
import { WorkerControls } from "./worker-controls";

/** The town's pipeline: a card sits in the column its stage earned. */
export type Stage = "blocked" | "ready" | "flight" | "review" | "landed";

export function stageOf(bead: BoardBead): Stage {
  if (bead.status === "closed") return "landed";
  if (bead.status === "review") return "review";
  if (bead.status === "in_progress") return "flight";
  return bead.ready ? "ready" : "blocked";
}

export const KANBAN_COLUMNS: { key: Stage; label: string; accent: string }[] = [
  { key: "blocked", label: "Blocked", accent: "text-destructive" },
  { key: "ready", label: "Ready", accent: "text-emerald-600 dark:text-emerald-400" },
  { key: "flight", label: "In flight", accent: "text-foreground" },
  { key: "review", label: "In review", accent: "text-amber-600 dark:text-amber-400" },
  { key: "landed", label: "Landed", accent: "text-muted-foreground" },
];

export function BeadCard({ bead, origin }: { bead: BoardBead; origin?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-1.5 text-xs" title={bead.id}>
      {origin ? (
        <p className="mb-0.5 truncate text-[11px] font-medium text-muted-foreground/80">{origin}</p>
      ) : null}
      <p className="line-clamp-2 leading-snug">{bead.title}</p>
      {bead.labels?.length ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{bead.labels.join(" · ")}</p>
      ) : null}
      {bead.threadId !== null ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={bead.threadId}>
          thread: {bead.threadState ?? "?"} · {bead.threadId.slice(0, 12)}
        </p>
      ) : null}
      {bead.threadId !== null ? <WorkerControls threadId={bead.threadId} /> : null}
    </div>
  );
}

export function KanbanColumns({ beads }: { beads: (BoardBead & { origin?: string })[] }) {
  const priorityOf = (bead: BoardBead) => (typeof bead.priority === "number" ? bead.priority : 99);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {KANBAN_COLUMNS.map((column) => {
        const columnBeads = beads
          .filter((bead) => stageOf(bead) === column.key)
          .sort((a, b) => priorityOf(a) - priorityOf(b) || a.title.localeCompare(b.title));
        return (
          <div key={column.key} className="min-w-0 space-y-1 rounded-md border border-border/60 bg-muted/30 p-1.5">
            <p className={`px-1 text-[11px] font-semibold uppercase tracking-wide ${column.accent}`}>
              {column.label} {columnBeads.length > 0 ? `· ${columnBeads.length}` : ""}
            </p>
            {columnBeads.length === 0 ? (
              <p className="px-1 py-0.5 text-[11px] text-muted-foreground/60">—</p>
            ) : (
              columnBeads.map((bead) => <BeadCard key={bead.id} bead={bead} origin={bead.origin} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

function TownHallPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<TownHallData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardView, setBoardView] = useState<"pipeline" | "convoys">("pipeline");
  const refetch = useCallback(() => {
    rpc.call("townHall", null).then((result) => {
      setData(result);
      setError(null);
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("town-changed", refetch);

  if (data !== null && data.status.townProjectId === null && data.status.mayor === null) {
    return (
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <TownOnboarding />
      </div>
    );
  }

  const problems =
    data?.status.threads.filter(
      (thread) => thread.role !== "mayor" && PROBLEM_STATES.has(thread.state),
    ) ?? [];
  const roster =
    data?.status.threads
      .filter((thread) => thread.role !== "mayor" && !["complete", "archived", "deleted"].includes(thread.state))
      .sort((a, b) => a.state.localeCompare(b.state) || a.title.localeCompare(b.title)) ?? [];

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {data === null ? (
          <p className="text-sm text-muted-foreground">Opening the town hall…</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm">
                {data.status.mayor
                  ? `${data.status.mayor.title} — ${data.status.mayor.state}`
                  : data.status.townProjectId
                    ? "Town set, no Mayor running — bb madmax start"
                    : ""}
              </p>
              {data.status.ledger !== null && data.status.ledger.initialized ? (
                <p className="shrink-0 text-xs text-muted-foreground">
                  {data.status.ledger.open} open · {data.status.ledger.ready} ready ·{" "}
                  {data.status.ledger.inProgress} running · {data.status.ledger.convoys} convoys
                </p>
              ) : null}
            </div>

            {problems.length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-destructive">
                  Needs attention
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-3">
                  {problems.map((thread) => (
                    <li key={thread.threadId} className="flex items-baseline gap-2 py-2 text-sm">
                      <span className="w-20 shrink-0 text-xs font-medium uppercase text-destructive">
                        {thread.state}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      {thread.blocker !== null ? (
                        <span className="max-w-[40%] truncate text-xs text-muted-foreground" title={thread.blocker}>
                          {thread.blocker}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {boardView === "pipeline" ? "Pipeline" : "Convoys"}
                  </h2>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-pressed={boardView === "pipeline"}
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                        boardView === "pipeline"
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-state-hover",
                      )}
                      onClick={() => setBoardView("pipeline")}
                    >
                      Town pipeline
                    </button>
                    <button
                      type="button"
                      aria-pressed={boardView === "convoys"}
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                        boardView === "convoys"
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-state-hover",
                      )}
                      onClick={() => setBoardView("convoys")}
                    >
                      By convoy
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground/80">
                  Read-only — stages change through the Mayor's tools
                </p>
              </div>
              {data.convoys.length === 0 && data.looseBeads.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {data.status.ledger?.initialized
                    ? "No open beads in the ledger yet — every slung task files one here automatically."
                    : data.status.ledger?.bdAvailable
                      ? "Ledger not initialized — run: bb madmax ledger init"
                      : "bd (Beads) is not installed on the bb server machine."}
                </p>
              ) : boardView === "pipeline" ? (
                <KanbanColumns
                  beads={[
                    ...data.convoys.flatMap((convoy) =>
                      convoy.beads.map((bead) => ({ ...bead, origin: convoy.title })),
                    ),
                    ...data.looseBeads.map((bead) => ({ ...bead, origin: "Loose" })),
                  ]}
                />
              ) : (
                <div className="space-y-3">
                  {data.convoys.map((convoy) => (
                    <ConvoyCard key={convoy.id} convoy={convoy} />
                  ))}
                  {data.looseBeads.length > 0 ? (
                    <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2">
                      <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Loose beads (no convoy)
                      </p>
                      <KanbanColumns beads={data.looseBeads} />
                    </div>
                  ) : null}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Roster
              </h2>
              {roster.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No managed threads — the Mayor slings work with town_sling.
                </p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-3">
                  {roster.map((thread) => (
                    <li key={thread.threadId} className="flex items-baseline gap-2 py-2 text-sm">
                      <span className="w-20 shrink-0 text-xs font-medium uppercase text-muted-foreground">
                        {thread.role === "polecat" ? thread.tier ?? "polecat" : thread.role}
                      </span>
                      <span
                        className={cn(
                          "w-16 shrink-0 text-xs font-medium uppercase",
                          PROBLEM_STATES.has(thread.state) ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {thread.state}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      {thread.beadId !== null ? (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {thread.beadId}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Activity
              </h2>
              {data.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Quiet so far.</p>
              ) : (
                <ul className="space-y-1">
                  {data.events.slice(0, 30).map((event, index) => (
                    <li key={`${event.at}-${index}`} className="flex items-baseline gap-2 text-sm">
                      <span className="w-14 shrink-0 text-xs text-muted-foreground">
                        {timeAgo(event.at)}
                      </span>
                      <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">
                        {event.kind}
                      </span>
                      <span className="min-w-0 flex-1">{event.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

const PROBLEM_STATES = new Set(["blocked", "failed"]);

export { TownHallPage };
