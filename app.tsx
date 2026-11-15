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
import type { ManagedThread, Rig, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type TownStatus = {
  sectionId: string | null;
  townProjectId: string | null;
  mayor: ManagedThread | null;
  threads: ManagedThread[];
  rigs: Rig[];
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

/** First-run chooser: where should the town live? */
function TownOnboarding() {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<TownProjectChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

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
          Welcome to your town. Choose the bb project that holds the Mayor and
          the town ledger.
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
            No bb projects yet — register a folder as your town below, or create
            a project in bb first.
          </p>
        ) : (
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
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-muted-foreground">Or a new folder:</span>
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
            className="w-56"
          />
          <Button
            variant="outline"
            disabled={busy !== null || name.trim() === "" || path.trim() === ""}
            onClick={() => void create()}
          >
            <Icon name="Plus" className="size-4" />
            {busy === "new-town" ? "Creating…" : "Create town"}
          </Button>
        </div>
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
