// bb-plugin-madmax — the role badge shown on managed threads' sidebar rows.
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { ManagedThread, rpcContract } from "../server";

type TownRoles = Record<string, { role: ManagedThread["role"]; tier: string | null; state: string }>;

/** One batched read for every thread a list may show (see useData contract). */
export function useTownRoles(): TownRoles | null {
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

export function TownRowBadge({
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
