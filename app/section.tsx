// bb-plugin-madmax — the Madmax section on bb's New Thread screen: a live town
// summary (problems first) and a Start Mayor launcher.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../server";
import type { TownStatus } from "./types";
import { TownOnboarding } from "./onboarding";

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

const PROBLEM_STATES = new Set(["blocked", "failed"]);

export { TownSection };
