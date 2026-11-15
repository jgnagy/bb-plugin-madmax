// bb-plugin-madmax — the town frontend.
//
// Phase 1 surface: a "Start Mayor" launcher on bb's New Thread screen with a
// live town summary (problems first), and a role badge on managed threads'
// sidebar rows. Phase 3 replaces the summary with the full Town Hall
// dashboard.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ManagedThread, Rig, rpcContract, BoardBead, TownEvent } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type TownStatus = {
  sectionId: string | null;
  townProjectId: string | null;
  mayor: ManagedThread | null;
  threads: ManagedThread[];
  rigs: Rig[];
  ledger: {
    bdAvailable: boolean;
    initialized: boolean;
    path: string | null;
    open: number;
    inProgress: number;
    ready: number;
    convoys: number;
  } | null;
};

const PROBLEM_STATES = new Set(["blocked", "failed"]);

function useTownStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<TownStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status", null).then((result) => {
      setStatus(result);
      setError(null);
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  // The server publishes after every town mutation — slings, reports,
  // lifecycle events — from this window, another window, or the CLI.
  useRealtime("town-changed", refetch);
  return { rpc, status, error };
}

function TownSection({ projectId }: { projectId: string | null }) {
  const navigate = useBbNavigate();
  const { rpc, status, error } = useTownStatus();
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const town = status?.townProjectId ?? projectId;
    if (town === null || isStarting) return;
    setStartError(null);
    setIsStarting(true);
    try {
      const result = await rpc.call("start", { projectId: town });
      navigate.toThread(result.threadId);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
      setIsStarting(false);
    }
  }, [isStarting, navigate, projectId, rpc, status?.townProjectId]);

  // First run: no town yet — ask where it should live instead of showing a
  // dead button.
  if (status !== null && status.mayor === null && status.townProjectId === null) {
    return <TownOnboarding />;
  }

  const polescatThreads = status?.threads.filter((thread) => thread.role !== "mayor") ?? [];
  const problems = polescatThreads.filter((thread) => PROBLEM_STATES.has(thread.state));
  const working = polescatThreads.filter((thread) => ["active", "starting", "pending"].includes(thread.state));
  const ready = polescatThreads.filter((thread) => thread.state === "ready");
  const townId = status?.townProjectId ?? projectId;

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-start gap-3 px-6 py-4 text-sm">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-foreground">
            {status?.mayor
              ? `Mayor is ${status.mayor.state} — ${status.mayor.title}`
              : "No Mayor yet. Start one to coordinate polecat threads across your rigs."}
          </p>
          {startError ?? error !== null ? (
            <p role="alert" className="text-destructive">
              {startError ?? error}
            </p>
          ) : null}
          {status !== null && polescatThreads.length > 0 ? (
            <p className="text-muted-foreground">
              {problems.length > 0 ? (
                <span className="text-destructive">
                  {problems.length} need attention —{" "}
                  {problems.map((thread) => thread.title).join(", ")}
                </span>
              ) : (
                <>
                  {working.length} working · {ready.length} awaiting verification
                </>
              )}
              {status.rigs.length > 0 ? (
                <> · rigs: {status.rigs.map((rig) => rig.name).join(", ")}</>
              ) : null}
            </p>
          ) : null}
          {status !== null && status.ledger !== null ? (
            <p className="text-xs text-muted-foreground">
              {status.ledger.bdAvailable
                ? status.ledger.initialized
                  ? `Ledger: ${status.ledger.open} open · ${status.ledger.ready} ready · ${status.ledger.convoys} convoys`
                  : "Ledger: not initialized — run: bb madmax ledger init"
                : "Ledger: bd (Beads) not installed on the bb server machine"}
            </p>
          ) : null}
        </div>
        <Button
          disabled={townId === null || isStarting || status?.mayor !== null}
          onClick={() => void start()}
        >
          <Icon name="Landmark" className="size-4" />
          {status?.mayor ? "Mayor running" : isStarting ? "Starting…" : "Start Mayor"}
        </Button>
      </div>
    </div>
  );
}

type TownProjectChoice = { projectId: string; name: string; kind: string };

type TownConvoy = { id: string; title: string; status: string; beads: BoardBead[] };

type TownHallData = {
  status: TownStatus;
  convoys: TownConvoy[];
  looseBeads: BoardBead[];
  events: TownEvent[];
};

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The town's pipeline: a card sits in the column its stage earned. */
type Stage = "blocked" | "ready" | "flight" | "review" | "landed";

function stageOf(bead: BoardBead): Stage {
  if (bead.status === "closed") return "landed";
  if (bead.status === "review") return "review";
  if (bead.status === "in_progress") return "flight";
  return bead.ready ? "ready" : "blocked";
}

const KANBAN_COLUMNS: { key: Stage; label: string; accent: string }[] = [
  { key: "blocked", label: "Blocked", accent: "text-destructive" },
  { key: "ready", label: "Ready", accent: "text-emerald-600 dark:text-emerald-400" },
  { key: "flight", label: "In flight", accent: "text-foreground" },
  { key: "review", label: "In review", accent: "text-amber-600 dark:text-amber-400" },
  { key: "landed", label: "Landed", accent: "text-muted-foreground" },
];

function BeadCard({ bead, origin }: { bead: BoardBead; origin?: string }) {
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
    </div>
  );
}

function KanbanColumns({ beads }: { beads: (BoardBead & { origin?: string })[] }) {
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

function ConvoyCard({ convoy }: { convoy: TownConvoy }) {
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
      .filter((thread) => thread.role !== "mayor" && thread.state !== "complete")
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
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                        boardView === "pipeline"
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-state-hover"
                      }`}
                      onClick={() => setBoardView("pipeline")}
                    >
                      Town pipeline
                    </button>
                    <button
                      type="button"
                      aria-pressed={boardView === "convoys"}
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                        boardView === "convoys"
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-state-hover"
                      }`}
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
                    ? "No convoys in the ledger yet — the Mayor creates them with town_convoy."
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
                        className={`w-16 shrink-0 text-xs font-medium uppercase ${
                          PROBLEM_STATES.has(thread.state) ? "text-destructive" : "text-muted-foreground"
                        }`}
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

type DirectoryBrowse = {
  hostId: string;
  directory: string;
  parent: string | null;
  roots: string[];
  directories: { name: string; path: string }[];
};

/** Folder picker dialog backed by hosts.directory on the connected host. */
function FolderBrowser({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<DirectoryBrowse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (path?: string) => {
      setListing(null);
      setError(null);
      rpc
        .call("browseTownDirectories", path ? { path } : {})
        .then(setListing, (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    },
    [rpc],
  );

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose a town folder</DialogTitle>
          <DialogDescription>
            Pick where the town lives on disk. The folder is created if it
            doesn't exist yet.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {listing === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {error === null ? "Loading folders…" : ""}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
                title={listing.directory}
              >
                {listing.directory}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Go to home folder"
                onClick={() => load()}
              >
                <Icon name="House" className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Go to parent folder"
                disabled={listing.parent === null}
                onClick={() => load(listing.parent ?? undefined)}
              >
                <Icon name="ArrowUp" className="size-4" />
              </Button>
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {listing.directories.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">
                  No subfolders here.
                </li>
              ) : (
                listing.directories.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => load(entry.path)}
                    >
                      <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={listing === null}
            onClick={() => {
              if (listing !== null) {
                onChoose(listing.directory);
                onOpenChange(false);
              }
            }}
          >
            <Icon name="Check" className="size-4" />
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** First-run chooser: where should the town live? */
function TownOnboarding() {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<TownProjectChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    setBusy(null);
  }, []);

  useEffect(() => {
    rpc.call("projectsList", null).then((result) => setProjects(result.projects), report);
  }, [rpc, report]);

  const choose = useCallback(async (projectId: string) => {
    if (busy !== null) return;
    setBusy(projectId);
    setError(null);
    try {
      const result = await rpc.call("chooseTown", { projectId });
      navigate.toThread(result.threadId);
    } catch (cause) {
      report(cause);
    }
  }, [busy, navigate, rpc, report]);

  const create = useCallback(async () => {
    if (busy !== null || name.trim() === "" || path.trim() === "") return;
    setBusy("new-town");
    setError(null);
    try {
      const result = await rpc.call("createTown", { name: name.trim(), path: path.trim() });
      navigate.toThread(result.threadId);
    } catch (cause) {
      report(cause);
    }
  }, [busy, name, navigate, path, rpc, report]);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="space-y-3 px-6 py-4 text-sm">
        <p className="text-foreground">
          Welcome to your town. Pick an existing project to import a town that
          already lives there — or create a dedicated folder below, which is
          how most towns start (it gets a git repo, a Beads ledger, and a
          rules starter).
        </p>
        {error !== null ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {projects === null ? (
          <p className="text-muted-foreground">Loading your projects…</p>
        ) : projects.length === 0 ? (
          <p className="text-muted-foreground">
            No bb projects to import — start your town with a new folder below.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Import a town from an existing bb project:
            </p>
            <ul className="flex flex-wrap gap-2">
              {projects.map((project) => (
                <li key={project.projectId}>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void choose(project.projectId)}
                  >
                    {busy === project.projectId ? "Starting…" : project.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm text-muted-foreground">
            Or a new town folder (created if missing):
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Town name"
              aria-label="New town name"
              className="w-40"
            />
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/path/to/town"
              aria-label="New town folder path"
              className="min-w-56 flex-1"
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Browse folders"
              disabled={busy !== null}
              onClick={() => setBrowseOpen(true)}
            >
              <Icon name="FolderOpen" className="size-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            disabled={busy !== null || name.trim() === "" || path.trim() === ""}
            onClick={() => void create()}
          >
            <Icon name="Plus" className="size-4" />
            {busy === "new-town" ? "Creating…" : "Create town"}
          </Button>
        </div>
        <FolderBrowser
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onChoose={(chosen) => setPath(chosen)}
        />
      </div>
    </div>
  );
}

type TownRoles = Record<string, { role: ManagedThread["role"]; tier: string | null; state: string }>;

/** One batched read for every thread a list may show (see useData contract). */
function useTownRoles(): TownRoles | null {
  const rpc = useRpc<typeof rpcContract>();
  const [roles, setRoles] = useState<TownRoles | null>(null);
  const load = useCallback(() => {
    rpc.call("status", null).then((result) => {
      const next: TownRoles = {};
      for (const thread of result.threads) {
        next[thread.threadId] = { role: thread.role, tier: thread.tier, state: thread.state };
      }
      setRoles(next);
    }).catch(() => setRoles({}));
  }, [rpc]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("town-changed", load);
  return roles;
}

function TownRowBadge({
  thread,
  data,
}: {
  thread: PluginSidebarThread;
  data: TownRoles | null;
}) {
  const entry = data?.[thread.id];
  if (!entry) return null;
  const label =
    entry.role === "mayor"
      ? "Mayor"
      : `${entry.role === "polecat" ? "Polecat" : "Reviewer"}${entry.tier ? ` · ${entry.tier}` : ""}`;
  return (
    <span
      title={`${label} — ${entry.state}`}
      className="inline-flex items-center gap-1 text-muted-foreground"
    >
      <Icon name={entry.role === "mayor" ? "Landmark" : "Hammer"} className="size-3" />
      {label}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "town-hall",
    title: "Town Hall",
    icon: "Landmark",
    path: "town-hall",
    component: TownHallPage,
  });
  app.slots.homepageSection({
    id: "madmax-town",
    title: "Madmax",
    component: TownSection,
  });
  app.slots.experimental_threadRowMetadata({
    id: "madmax-role",
    order: 10,
    useData: () => useTownRoles(),
    component: TownRowBadge,
  });
});
