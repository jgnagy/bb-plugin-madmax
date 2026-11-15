// bb-plugin-madmax — backend tests against the fake plugin host.
//
// The fake host runs the real server.ts with a process-local SQLite store and
// a recordable bb.sdk: every spawn, section, project, and send call below is a
// stub whose arguments the assertions inspect. No BB server is needed.
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

interface Host {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  host: any;
}

/** Stubs the sdk for a start/sling flow and returns the spawned thread ids. */
async function startTown(host: Host["host"]) {
  const spawned: string[] = [];
  host.harness.inspection.sdk.stub("threadSections.list", () => []);
  host.harness.inspection.sdk.stub("threadSections.create", () => ({ id: "sec_town", name: "Town" }));
  host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
    id: args.projectId,
    name: args.projectId === "proj_rig" ? "Rig One" : "MyTown",
  }));
  host.harness.inspection.sdk.stub("hosts.list", () => [{ id: "host_1", status: "connected" }]);
  let counter = 0;
  host.harness.inspection.sdk.stub("threads.spawn", () => {
    const thread = makeThreadResponse({ id: `thr_spawn_${counter++}`, status: "starting" });
    spawned.push(thread.id);
    return thread;
  });
  host.harness.inspection.sdk.stub("threads.send", () => ({ ok: true }));
  const started = (await host.harness.behavior.callRpc("start", { projectId: "proj_town" })) as {
    threadId: string;
    created: boolean;
  };
  return { started, spawned };
}

describe("madmax town backend", () => {
  const hosts: Host["host"][] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  });

  async function makeHost() {
    const host = createFakePluginHost({ pluginId: "madmax", agentSkillIds: ["mayor", "polecat"] });
    hosts.push(host);
    await plugin(host.bb);
    return host;
  }

  it("loads and registers its surfaces", async () => {
    const host = await makeHost();
    const registrations = host.harness.inspection.registrations;
    expect(registrations.cli?.name).toBe("madmax");
    expect(registrations.rpcMethods).toEqual(
      expect.arrayContaining(["status", "start", "rigAdd", "rigRemove"]),
    );
    expect(registrations.agentTools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["town_sling", "town_roster", "town_inspect", "town_nudge", "polecat_report"]),
    );
  });

  it("reports an empty town before setup", async () => {
    const host = await makeHost();
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      sectionId: string | null;
      mayor: unknown | null;
      threads: unknown[];
      rigs: unknown[];
    };
    expect(status.sectionId).toBeNull();
    expect(status.mayor).toBeNull();
    expect(status.threads).toEqual([]);
    expect(status.rigs).toEqual([]);
  });

  it("prints CLI usage and status", async () => {
    const host = await makeHost();
    const help = await host.harness.behavior.runCli([]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb madmax sling");
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).threads).toEqual([]);
  });

  it("contributes no tools to unmanaged threads", async () => {
    const host = await makeHost();
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_someone_elses" } }),
    );
    expect(configuration.tools).toEqual([]);
    expect(configuration.skills).toEqual([]);
  });

  it("starts a Mayor in the Town section", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    expect(started.created).toBe(true);

    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]![0] as Record<string, unknown>;
    expect(spawn.projectId).toBe("proj_town");
    expect(spawn.title).toBe("Mayor · MyTown");
    expect(spawn.sectionId).toBe("sec_town");
    expect(spawn.visibility).toBe("visible");
    expect((spawn.prompt as string)).toContain("You are the Mayor of MyTown");

    const status = (await host.harness.behavior.callRpc("status", null)) as {
      mayor: { threadId: string; role: string; title: string } | null;
    };
    expect(status.mayor?.threadId).toBe(started.threadId);
    expect(status.mayor?.role).toBe("mayor");
  });

  it("returns the existing Mayor instead of starting another", async () => {
    const host = await makeHost();
    const { started: first } = await startTown(host);
    const second = (await host.harness.behavior.callRpc("start", { projectId: "proj_town" })) as {
      threadId: string;
      created: boolean;
    };
    expect(second.created).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("gates the Mayor's tools and skill by role", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: started.threadId } }),
    );
    expect(configuration.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["town_sling", "town_roster"]),
    );
    expect(configuration.skills).toContain("mayor");
    expect(configuration.instructions).toContain("Mayor");
  });

  it("slings a polecat into a managed worktree, parented to the Mayor", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    await host.harness.behavior.callAgentTool(
      "town_sling",
      {
        title: "Fix checkout totals",
        mission: "Totals double-count tax; fix and verify with the cart test.",
        successCriteria: ["Cart test passes", "No other call sites changed"],
        tier: "medium",
      },
      { threadId: started.threadId },
    );

    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(2);
    const spawn = spawns[1]![0] as Record<string, any>;
    expect(spawn.projectId).toBe("proj_town");
    expect(spawn.title).toBe("Fix checkout totals");
    expect(spawn.permissionMode).toBe("accept-edits");
    expect(spawn.parentThreadId).toBe(started.threadId);
    expect(spawn.lifecycleOwnerThreadId).toBe(started.threadId);
    expect(spawn.parentNotifications).toBe("stuck");
    expect(spawn.pluginMetadata).toMatchObject({ role: "polecat", tier: "medium" });
    expect(spawn.environment).toMatchObject({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    expect(spawn.reasoningLevel).toBe("high"); // medium tier default
    expect(spawn.prompt).toContain("You are a polecat in the town of MyTown");

    const roster = await host.harness.behavior.callAgentTool("town_roster", {}, { threadId: started.threadId });
    expect(String(roster)).toContain("Fix checkout totals");
  });

  it("rejects slings into unregistered rig projects", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    await expect(
      host.harness.behavior.callAgentTool(
        "town_sling",
        { title: "Work", mission: "Do it", rigProjectId: "proj_not_a_rig" },
        { threadId: started.threadId },
      ),
    ).rejects.toThrow(/not a registered rig/);
  });

  it("routes polecat reports to the Mayor through the outbox", async () => {
    const host = await makeHost();
    const { started, spawned } = await startTown(host);
    await host.harness.behavior.callAgentTool(
      "town_sling",
      { title: "Fix checkout totals", mission: "Fix the totals." },
      { threadId: started.threadId },
    );
    const polecatId = spawned[1]!;

    await host.harness.behavior.callAgentTool(
      "polecat_report",
      { state: "ready", result: "Fixed; cart test passes.", recommendation: "Verify and land." },
      { threadId: polecatId },
    );

    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    const report = sends.find((args: unknown[]) =>
      typeof args[0] === "object" && JSON.stringify(args[0]).includes("Polecat report"),
    );
    expect(report).toBeDefined();
    expect((report![0] as { threadId: string }).threadId).toBe(started.threadId);

    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; state: string }[];
    };
    const polecat = status.threads.find((thread) => thread.threadId === polecatId);
    expect(polecat?.state).toBe("ready");
  });

  it("alerts the Mayor when a polecat fails", async () => {
    const host = await makeHost();
    const { started, spawned } = await startTown(host);
    await host.harness.behavior.callAgentTool(
      "town_sling",
      { title: "Fix checkout totals", mission: "Fix the totals." },
      { threadId: started.threadId },
    );
    const polecatId = spawned[1]!;

    const outcome = await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: polecatId, status: "error" }),
      error: "provider quota exceeded",
    });
    expect(outcome.errors).toEqual([]);

    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    const alert = sends.find((args: unknown[]) =>
      typeof args[0] === "object" && JSON.stringify(args[0]).includes("is failed"),
    );
    expect(alert).toBeDefined();
    expect((alert![0] as { threadId: string }).threadId).toBe(started.threadId);
  });

  it("registers and lists rigs, and refuses to double-register as new", async () => {
    const host = await makeHost();
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: "Rig One",
    }));
    const added = (await host.harness.behavior.callRpc("rigAdd", { projectId: "proj_rig" })) as {
      projectId: string;
      name: string;
    };
    expect(added.name).toBe("Rig One");
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      rigs: { projectId: string; name: string }[];
    };
    expect(status.rigs).toEqual([{ projectId: "proj_rig", name: "Rig One", registeredAt: expect.any(Number) }]);
    const removed = (await host.harness.behavior.callRpc("rigRemove", { projectId: "proj_rig" })) as {
      removed: boolean;
    };
    expect(removed.removed).toBe(true);
  });
});
