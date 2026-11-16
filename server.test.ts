// bb-plugin-madmax — backend tests against the fake plugin host.
//
// The fake host runs the real server.ts with a process-local SQLite store and
// a recordable bb.sdk: every spawn, section, project, and send call below is a
// stub whose arguments the assertions inspect. No BB server is needed.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { type Bead } from "./server";

const execFileAsync = promisify(execFile);
const bdAvailable = await execFileAsync("bd", ["--version"])
  .then(() => true)
  .catch(() => false);

type TownHallShape = {
  status: { townProjectId: string | null };
  convoys: {
    id: string;
    title: string;
    status: string;
    beads: {
      id: string;
      title: string;
      status: string;
      ready: boolean;
      threadId: string | null;
      threadState: string | null;
    }[];
  }[];
  looseBeads: { id: string }[];
  events: { at: number; kind: string; message: string }[];
};

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

  it("slings with owner-approved PR authorization in the brief", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    await host.harness.behavior.callAgentTool(
      "town_sling",
      {
        title: "Fix checkout totals",
        mission: "Totals double-count tax; fix and verify with the cart test.",
        openPr: true,
      },
      { threadId: started.threadId },
    );
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const prompt = (spawns[spawns.length - 1]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("The owner approved opening a pull request for this task.");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("Put the pull request URL in your final report.");
  });

  it("adopts an existing thread as a polecat and re-points a Mayor", async () => {
    const host = await makeHost();
    const { started } = await startTown(host);
    host.harness.inspection.sdk.stub("threads.update", () => ({ ok: true }));
    // A pre-madmax worker thread, idle, in a project of its own.
    host.harness.inspection.sdk.stub("threads.get", (args: { threadId: string }) =>
      makeThreadResponse({
        id: args.threadId,
        status: "idle",
        projectId: "proj_elsewhere",
        title: "Old worker thread",
        deletedAt: null,
        archivedAt: null,
      }));

    const adopted = await host.harness.behavior.callAgentTool(
      "town_adopt",
      { threadId: "thr_pre_madmax" },
      { threadId: started.threadId },
    );
    expect(String(adopted)).toContain("Adopted thread thr_pre_madmax as polecat");

    // The thread was re-filed into the Town section, visibly, un-renamed.
    const updates = host.harness.inspection.sdk.callsTo("threads.update");
    expect(updates[updates.length - 1]![0]).toMatchObject({
      threadId: "thr_pre_madmax",
      sectionId: "sec_town",
      visibility: "visible",
    });

    // It appears on the roster and is gated like a polecat.
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string }[];
    };
    const adoptedRow = status.threads.find((thread) => thread.threadId === "thr_pre_madmax");
    expect(adoptedRow?.role).toBe("polecat");
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_pre_madmax" } }),
    );
    expect(configuration.tools.map((tool: { name: string }) => tool.name)).toEqual(["polecat_report"]);

    // Adopting a new Mayor retires the old one and re-points the roster.
    host.harness.inspection.sdk.stub("threads.get", (args: { threadId: string }) =>
      makeThreadResponse({
        id: args.threadId,
        status: "idle",
        projectId: "proj_town",
        title: "New Mayor thread",
        deletedAt: null,
        archivedAt: null,
      }));
    const reMayored = await host.harness.behavior.callAgentTool(
      "town_adopt",
      { threadId: "thr_new_mayor", role: "mayor" },
      { threadId: started.threadId },
    );
    expect(String(reMayored)).toContain("The previous Mayor is retired");
    const after = (await host.harness.behavior.callRpc("status", null)) as {
      mayor: { threadId: string } | null;
      threads: { threadId: string; role: string; mayorThreadId: string | null }[];
    };
    expect(after.mayor?.threadId).toBe("thr_new_mayor");
    const rePointed = after.threads.find((thread) => thread.threadId === "thr_pre_madmax");
    expect(rePointed?.mayorThreadId).toBe("thr_new_mayor");
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
    // Without a resolvable local source, the Mayor falls back to the
    // project's default environment.
    expect(spawn.environment).toEqual({ type: "project-default" });
    expect((spawn.prompt as string)).toContain("You are the Mayor of MyTown");
    expect((spawn.prompt as string)).toContain("this thread stays responsive");
    expect((spawn.prompt as string)).toContain("Never run long-blocking commands");

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
    expect(spawn.prompt).toContain("You work for the town of MyTown");
    expect(spawn.prompt).toContain("## Task");
    expect(spawn.prompt).toContain("Do not open a pull request");

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

  it("asks where the town should live when starting without one", async () => {
    const host = await makeHost();
    host.harness.inspection.sdk.stub("projects.list", () => [
      { id: "proj_town", name: "MyTown", kind: "standard" },
    ]);
    const result = await host.harness.behavior.runCli(["start"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("where should the town live");
    expect(result.stderr).toContain("MyTown (proj_town)");
    expect(result.stderr).toContain("bb madmax init");
  });

  it("chooseTown persists the town project and starts its Mayor", async () => {
    const host = await makeHost();
    await startTown(host);
    const before = (await host.harness.behavior.callRpc("status", null)) as {
      townProjectId: string | null;
    };
    expect(before.townProjectId).toBe("proj_town"); // via the running Mayor's project

    const chosen = (await host.harness.behavior.callRpc("chooseTown", { projectId: "proj_town" })) as {
      threadId: string;
      created: boolean;
    };
    // A Mayor was already running for proj_town, so the choice reuses it.
    expect(chosen.created).toBe(false);
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      townProjectId: string | null;
      mayor: { threadId: string } | null;
    };
    expect(status.townProjectId).toBe("proj_town");
    expect(status.mayor?.threadId).toBe(chosen.threadId);

    // The town is settled; moving it requires the explicit config command.
    await expect(
      host.harness.behavior.callRpc("chooseTown", { projectId: "proj_elsewhere" }),
    ).rejects.toThrow(/already set/);
  });

  it("createTown bootstraps the folder, seeds town.md, and registers it", async () => {
    const host = await makeHost();
    await startTown(host);
    host.harness.inspection.sdk.stub("files.mkdir", () => ({ ok: true }));
    host.harness.inspection.sdk.stub("files.read", () => {
      throw new Error("ENOENT: no such file");
    });
    host.harness.inspection.sdk.stub("files.write", () => ({ ok: true }));
    host.harness.inspection.sdk.stub("projects.create", (args: { name: string }) => ({
      id: "proj_new_town",
      name: args.name,
      kind: "standard",
      sources: [],
    }));
    const created = (await host.harness.behavior.callRpc("createTown", {
      name: "New Town",
      path: "/tmp/town",
    })) as { projectId: string; threadId: string; created: boolean };
    expect(created.projectId).toBe("proj_new_town");
    expect(created.created).toBe(true);

    const mkdirs = host.harness.inspection.sdk.callsTo("files.mkdir");
    expect(mkdirs).toHaveLength(1);
    expect(mkdirs[0]![0]).toMatchObject({ hostId: "host_1", path: "/tmp/town", recursive: true });

    const writes = host.harness.inspection.sdk.callsTo("files.write");
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({ path: "/tmp/town/town.md", contentEncoding: "utf8" });
    expect((writes[0]![0] as { content: string }).content).toContain("# Town rules");

    const createCalls = host.harness.inspection.sdk.callsTo("projects.create");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![0]).toMatchObject({
      name: "New Town",
      source: { type: "local_path", hostId: "host_1", path: "/tmp/town" },
    });

    const status = (await host.harness.behavior.callRpc("status", null)) as {
      townProjectId: string | null;
      mayor: { threadId: string } | null;
    };
    expect(status.townProjectId).toBe("proj_new_town");
    expect(status.mayor?.threadId).toBe(created.threadId);
  });

  it("browseTownDirectories lists only directories from the host", async () => {
    const host = await makeHost();
    host.harness.inspection.sdk.stub("hosts.list", () => [{ id: "host_1", status: "connected" }]);
    host.harness.inspection.sdk.stub("hosts.directory", (args: { path?: string }) => ({
      directory: args.path ?? "/Users/demo",
      parent: args.path ? "/Users" : null,
      roots: ["/"],
      entries: [
        { kind: "directory", name: "zed", path: "/Users/demo/zed" },
        { kind: "file", name: "notes.txt", path: "/Users/demo/notes.txt" },
        { kind: "directory", name: "alpha", path: "/Users/demo/alpha" },
        { kind: "file", name: "town.md", path: "/Users/demo/town.md" },
        { kind: "directory", name: ".hidden", path: "/Users/demo/.hidden" },
      ],
    }));
    const top = (await host.harness.behavior.callRpc("browseTownDirectories", {})) as {
      directory: string;
      directories: { name: string }[];
    };
    expect(top.directory).toBe("/Users/demo");
    expect(top.directories.map((entry) => entry.name)).toEqual([".hidden", "alpha", "zed"]);

    const inside = (await host.harness.behavior.callRpc("browseTownDirectories", {
      path: "/Users/demo/alpha",
    })) as { directory: string; parent: string | null };
    expect(inside.directory).toBe("/Users/demo/alpha");
    expect(inside.parent).toBe("/Users");
    expect(
      host.harness.inspection.sdk.callsTo("hosts.directory")[1]![0],
    ).toMatchObject({ hostId: "host_1", path: "/Users/demo/alpha" });
  });

  it("createTown keeps an existing town.md and expands ~ paths", async () => {
    const host = await makeHost();
    await startTown(host);
    host.harness.inspection.sdk.stub("files.mkdir", () => ({ ok: true }));
    host.harness.inspection.sdk.stub("files.read", () => ({
      content: "# My own rules",
      contentEncoding: "utf8",
    }));
    host.harness.inspection.sdk.stub("files.write", () => ({ ok: true }));
    host.harness.inspection.sdk.stub("projects.create", (args: { name: string }) => ({
      id: "proj_kept_town",
      name: args.name,
      kind: "standard",
      sources: [],
    }));
    await host.harness.behavior.callRpc("createTown", {
      name: "Kept Town",
      path: "~/towns/kept",
    });

    // The owner's rules file is never overwritten.
    expect(host.harness.inspection.sdk.callsTo("files.write")).toHaveLength(0);

    // ~ expands against the server's home, not the caller's cwd.
    const mkdirs = host.harness.inspection.sdk.callsTo("files.mkdir");
    expect(mkdirs[0]![0]).toMatchObject({
      path: resolve(homedir(), "towns/kept"),
      recursive: true,
    });
  });
});

describe.skipIf(!bdAvailable)("madmax ledger (real bd)", () => {
  const hosts: ReturnType<typeof createFakePluginHost>[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  });

  async function bdList(dir: string): Promise<Bead[]> {
    const { stdout } = await execFileAsync("bd", ["-C", dir, "list", "--all", "--json"], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Bead[];
    return Array.isArray(parsed) ? parsed : (parsed as unknown as { issues: Bead[] }).issues;
  }

  type ShownBead = Bead & {
    dependencies?: { id?: string; dependency_type?: string }[];
  };

  async function bdShow(dir: string, id: string): Promise<ShownBead> {
    const { stdout } = await execFileAsync("bd", ["-C", dir, "show", id, "--json"], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return (JSON.parse(stdout) as ShownBead[])[0]!;
  }

  /** A fake host whose town project sources a real, bd-initialized temp dir. */
  async function makeLedgerHost() {
    const host = createFakePluginHost({ pluginId: "madmax", agentSkillIds: ["mayor", "polecat"] });
    hosts.push(host);
    await plugin(host.bb);
    const dir = await mkdtemp(join(tmpdir(), "madmax-ledger-"));
    await execFileAsync("bd", ["init"], { cwd: dir, timeout: 120_000 });
    await execFileAsync("bd", ["config", "set", "status.custom", "review"], { cwd: dir, timeout: 60_000 });
    host.harness.inspection.sdk.stub("threadSections.list", () => []);
    host.harness.inspection.sdk.stub("threadSections.create", () => ({ id: "sec_town", name: "Town" }));
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: args.projectId === "proj_rig" ? "authify" : "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));
    host.harness.inspection.sdk.stub("hosts.list", () => [{ id: "host_1", status: "connected" }]);
    let counter = 0;
    host.harness.inspection.sdk.stub("threads.spawn", () =>
      makeThreadResponse({ id: `thr_ledger_${counter++}`, status: "starting" }));
    host.harness.inspection.sdk.stub("threads.send", () => ({ ok: true }));
    host.harness.inspection.sdk.stub("threads.get", (args: { threadId: string }) =>
      makeThreadResponse({ id: args.threadId, status: "idle", environmentId: "env_work_1" }));
    await host.harness.behavior.setSettings({ townProject: "proj_town" });
    const started = (await host.harness.behavior.callRpc("start", { projectId: "proj_town" })) as {
      threadId: string;
      created: boolean;
    };
    return { host, dir, mayorId: started.threadId };
  }

  it("the Mayor runs directly in the town checkout, never a worktree", async () => {
    const { host, dir } = await makeLedgerHost();
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const mayorSpawn = spawns[0]![0] as Record<string, unknown>;
    expect(mayorSpawn.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "unmanaged", path: dir },
    });
    expect(String(mayorSpawn.prompt)).toContain("You run directly in the town checkout");
  });

  it("town_convoy creates an epic with labeled, ordered beads", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const result = await host.harness.behavior.callAgentTool(
      "town_convoy",
      {
        goal: "Ship auth",
        description: "Auth for the app",
        rig: "authify",
        beads: [
          { title: "Add login endpoint", description: "D1: build the endpoint; done-when tests pass.", priority: 1 },
          { title: "Wire session middleware", description: "D2: wire sessions; done-when refresh works.", dependsOn: [0] },
        ],
      },
      { threadId: mayorId },
    );
    expect(String(result)).toContain("Convoy created");

    const issues = await bdList(dir);
    const epic = issues.find((issue) => issue.issue_type === "epic");
    const first = issues.find((issue) => issue.title === "Add login endpoint");
    const second = issues.find((issue) => issue.title === "Wire session middleware");
    expect(epic?.title).toBe("Ship auth");
    expect(first?.parent).toBe(epic?.id);
    expect(second?.parent).toBe(epic?.id);
    expect(first?.labels).toContain("authify");
    expect(second?.labels).toContain("authify");

    // show --json expands dependencies to full issues keyed by id; the
    // parent-child edge points at the epic, so a match on bead 1's id is
    // the blocked-by edge town_convoy created.
    const shown = await bdShow(dir, second!.id);
    expect(shown.dependencies?.some((dep) => dep.id === first!.id)).toBe(true);
  });

  it("slinging a bead claims it, routes by rig label, and links the thread", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    await host.harness.behavior.callRpc("rigAdd", { projectId: "proj_rig" });
    await host.harness.behavior.callAgentTool(
      "town_convoy",
      {
        goal: "Ship auth",
        beads: [{ title: "Add login endpoint", description: "D1: build it.", rig: "authify" }],
      },
      { threadId: mayorId },
    );
    const bead = (await bdList(dir)).find((issue) => issue.title === "Add login endpoint")!;

    const ready = await host.harness.behavior.callAgentTool("town_ready", {}, { threadId: mayorId });
    expect(String(ready)).toContain("Add login endpoint");

    await host.harness.behavior.callAgentTool(
      "town_sling",
      { beadId: bead.id, tier: "small" },
      { threadId: mayorId },
    );

    // The authify label routed the polecat into the registered rig project.
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const polecatSpawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    expect(polecatSpawn.projectId).toBe("proj_rig");
    expect((polecatSpawn.pluginMetadata as Record<string, unknown>).beadId).toBe(bead.id);
    // The bead id travels in metadata only — never in the brief text, and
    // the brief forbids town vocabulary in delivered artifacts.
    expect(polecatSpawn.prompt).not.toContain(bead.id);
    expect(polecatSpawn.prompt).toContain("Do not mention the town, the Mayor, polecats, beads, or internal ids");

    // The bead is claimed by the town.
    const shown = await bdShow(dir, bead.id);
    expect(shown.status).toBe("in_progress");
    expect((shown as unknown as { assignee?: string }).assignee ?? shown.assignee).toBeTruthy();

    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; beadId: string | null }[];
      ledger: { initialized: boolean; inProgress: number } | null;
    };
    const polecat = status.threads.find((thread) => thread.role !== "mayor");
    expect(polecat?.beadId).toBe(bead.id);
    expect(status.ledger?.initialized).toBe(true);
    expect(status.ledger?.inProgress).toBe(1);
  });

  it("townHall shows the board with linked threads and a newest-first feed", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    await host.harness.behavior.callAgentTool(
      "town_convoy",
      {
        goal: "Ship auth",
        beads: [
          { title: "Add login endpoint", description: "D1: build it." },
          { title: "Wire sessions", description: "D2: wire it.", dependsOn: [0] },
        ],
      },
      { threadId: mayorId },
    );
    const first = (await bdList(dir)).find((issue) => issue.title === "Add login endpoint")!;
    await host.harness.behavior.callAgentTool("town_sling", { beadId: first.id }, { threadId: mayorId });

    const hall = (await host.harness.behavior.callRpc("townHall", null)) as TownHallShape;
    expect(hall.convoys).toHaveLength(1);
    expect(hall.convoys[0]!.title).toBe("Ship auth");
    const beads = hall.convoys[0]!.beads;
    expect(beads.map((bead) => bead.title)).toEqual(["Add login endpoint", "Wire sessions"]);
    // Bead 1 is claimed by a running polecat; bead 2 is blocked by it.
    expect(beads[0]!.threadId).not.toBeNull();
    expect(beads[0]!.threadState).toBe("starting");
    expect(beads[0]!.ready).toBe(false);
    expect(beads[1]!.ready).toBe(false);
    expect(beads[1]!.threadId).toBeNull();

    // The feed is newest-first and carries the whole story so far.
    const kinds = hall.events.map((event) => event.kind);
    expect(kinds).toContain("mayor");
    expect(kinds).toContain("convoy");
    expect(kinds).toContain("sling");
    expect(kinds.indexOf("sling")).toBeLessThan(kinds.indexOf("convoy"));
    expect(kinds.indexOf("convoy")).toBeLessThan(kinds.indexOf("mayor"));

    // Loose beads section is empty when everything is parented.
    expect(hall.looseBeads).toHaveLength(0);
  });

  it("reports land on the bead; completion closes it", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    await host.harness.behavior.callAgentTool(
      "town_convoy",
      { goal: "Ship auth", beads: [{ title: "Add login endpoint", description: "D1: build it." }] },
      { threadId: mayorId },
    );
    const bead = (await bdList(dir)).find((issue) => issue.title === "Add login endpoint")!;
    await host.harness.behavior.callAgentTool("town_sling", { beadId: bead.id }, { threadId: mayorId });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2); // mayor + polecat
    const statusAfter = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string; beadId: string | null }[];
    };
    const polecat = statusAfter.threads.find((thread) => thread.role === "polecat")!;
    expect(polecat.beadId).toBe(bead.id);

    await host.harness.behavior.callAgentTool(
      "polecat_report",
      { state: "ready", result: "Fixed; cart test passes.", recommendation: "Verify and land." },
      { threadId: polecat.threadId },
    );

    const afterReport = await bdList(dir);
    const commented = afterReport.find((issue) => issue.id === bead.id)!;
    expect(commented.comment_count ?? 0).toBeGreaterThan(0);
    expect(commented.status).toBe("in_progress"); // reports do not close beads

    const completed = await host.harness.behavior.callAgentTool(
      "town_complete",
      { threadId: polecat.threadId, result: "Verified: tests green." },
      { threadId: mayorId },
    );
    expect(String(completed)).toContain("closed in the ledger");

    const afterComplete = await bdList(dir);
    const closed = afterComplete.find((issue) => issue.id === bead.id)!;
    expect(closed.status).toBe("closed");
  });

  /** A real git worktree with a bare origin, a polecat branch, and uncommitted work. */
  async function makeWorktree() {
    const worktree = await mkdtemp(join(tmpdir(), "madmax-worktree-"));
    const origin = await mkdtemp(join(tmpdir(), "madmax-origin-"));
    const git = (args: string[]) => execFileAsync("git", args, { cwd: worktree, timeout: 30_000 });
    await execFileAsync("git", ["init", "--bare", "-b", "main", origin], { timeout: 30_000 });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "town@test"]);
    await git(["config", "user.name", "Town Test"]);
    await git(["remote", "add", "origin", origin]);
    await writeFile(join(worktree, "README.md"), "town\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "init"]);
    await git(["push", "-u", "origin", "main"]);
    await git(["checkout", "-b", "bb/polecat-1"]);
    await writeFile(join(worktree, "fix.txt"), "fixed\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "polecat work"]);
    await writeFile(join(worktree, "fix.txt"), "fixed\nplus uncommitted polish\n");
    return { worktree, origin };
  }

  /** Create a one-bead convoy, sling it, and return the worker's thread id. */
  async function slingFirstBead(host: Host["host"], dir: string, mayorId: string, title = "Add login endpoint") {
    await host.harness.behavior.callAgentTool(
      "town_convoy",
      { goal: "Ship auth", beads: [{ title, description: "D1: build it." }] },
      { threadId: mayorId },
    );
    const bead = (await bdList(dir)).find((issue) => issue.title === title)!;
    await host.harness.behavior.callAgentTool(
      "town_sling",
      { beadId: bead.id, tier: "small" },
      { threadId: mayorId },
    );
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string }[];
    };
    return status.threads.find((thread) => thread.role === "polecat")!.threadId;
  }

  it("town_review commissions a read-only reviewer in the worker's worktree", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const polecatId = await slingFirstBead(host, dir, mayorId);

    const review = await host.harness.behavior.callAgentTool(
      "town_review",
      { threadId: polecatId, focus: "error handling" },
      { threadId: mayorId },
    );
    expect(String(review)).toContain("Started");

    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const reviewerSpawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    expect(reviewerSpawn.environment).toEqual({ type: "reuse", environmentId: "env_work_1" });
    expect(reviewerSpawn.pluginMetadata).toMatchObject({ role: "reviewer" });
    expect(reviewerSpawn.title).toBe("Review · Add login endpoint");

    // A second review request dedupes to the existing reviewer.
    await host.harness.behavior.callAgentTool("town_review", { threadId: polecatId }, { threadId: mayorId });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawns.length);

    // The reviewer is role-gated like a polecat: report tool only.
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string }[];
    };
    const reviewer = status.threads.find((thread) => thread.role === "reviewer")!;
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: reviewer.threadId } }),
    );
    expect(configuration.tools.map((tool: { name: string }) => tool.name)).toEqual(["polecat_report"]);
    expect(configuration.skills).toContain("polecat");
  });

  it("town_verify gathers evidence; town_land commits, pushes, and moves the bead to review", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const { worktree, origin } = await makeWorktree();
    host.harness.inspection.sdk.stub("environments.get", () => ({
      id: "env_work_1",
      path: worktree,
      branchName: "bb/polecat-1",
      hostId: "host_1",
      isGitRepo: true,
      isWorktree: true,
      name: null,
    }));
    const polecatId = await slingFirstBead(host, dir, mayorId);

    const evidence = String(
      await host.harness.behavior.callAgentTool("town_verify", { threadId: polecatId }, { threadId: mayorId }),
    );
    expect(evidence).toContain("Worktree:");
    expect(evidence).toContain("bb/polecat-1");
    expect(evidence).toContain("fix.txt"); // the uncommitted polish shows up

    const landed = String(
      await host.harness.behavior.callAgentTool("town_land", { threadId: polecatId }, { threadId: mayorId }),
    );
    expect(landed).toContain("bb/polecat-1 pushed to origin");
    expect(landed).toContain("uncommitted work committed");

    // The commit the town wrote in the rig carries no town vocabulary.
    const lastCommit = await execFileAsync("git", ["-C", worktree, "log", "-1", "--format=%s"]);
    expect(lastCommit.stdout.trim()).toBe("Add login endpoint");
    expect(lastCommit.stdout).not.toMatch(/bead|polecat|mayor|town/i);

    // The origin received the branch.
    const remote = await execFileAsync("git", ["-C", origin, "branch", "--list", "bb/polecat-1"]);
    expect(remote.stdout.trim()).toBe("bb/polecat-1");

    // The worktree is clean after landing.
    const clean = await execFileAsync("git", ["-C", worktree, "status", "--porcelain"]);
    expect(clean.stdout.trim()).toBe("");

    // The bead sits in review with the landing recorded.
    const issues = await bdList(dir);
    const bead = issues.find((issue) => issue.title === "Add login endpoint")!;
    expect(bead.status).toBe("review");
    expect(bead.comment_count ?? 0).toBeGreaterThan(0);
  });

  it("town_create_rig clones a repo, registers it, and slings route into it", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const { origin } = await makeWorktree();
    host.harness.inspection.sdk.stub("projects.create", (args: { name: string }) => ({
      id: "proj_cloned_rig",
      name: args.name,
      kind: "standard",
      sources: [],
    }));
    const rigName = origin.split("/").pop()!;

    // In production the bb project carries the cloned repo's name; mirror
    // that in the stub so registration and label routing resolve the rig.
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: args.projectId === "proj_cloned_rig" ? rigName : args.projectId === "proj_rig" ? "authify" : "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));

    const result = await host.harness.behavior.callAgentTool(
      "town_create_rig",
      { gitUrl: origin },
      { threadId: mayorId },
    );
    expect(String(result)).toContain(`Rig “${rigName}” is ready`);

    // The clone really happened, inside the town's rigs/ directory.
    const rigPath = join(dir, "rigs", rigName);
    expect(existsSync(join(rigPath, ".git"))).toBe(true);
    expect(existsSync(join(rigPath, "README.md"))).toBe(true);

    // It was registered as a bb project from the local path, and as a rig.
    const createCalls = host.harness.inspection.sdk.callsTo("projects.create");
    expect(createCalls[createCalls.length - 1]![0]).toMatchObject({
      name: rigName,
      source: { type: "local_path", hostId: "host_1", path: rigPath },
    });
    const hall = (await host.harness.behavior.callRpc("townHall", null)) as {
      status: { rigs: { projectId: string }[] };
      events: { kind: string }[];
    };
    expect(hall.status.rigs.some((rig) => rig.projectId === "proj_cloned_rig")).toBe(true);
    expect(hall.events.some((event) => event.kind === "rig")).toBe(true);

    // And a bead tagged with the rig label routes there automatically.
    await host.harness.behavior.callAgentTool(
      "town_convoy",
      { goal: "Fix the thing", beads: [{ title: "Fix it", description: "D1.", rig: rigName }] },
      { threadId: mayorId },
    );
    const bead = (await bdList(dir)).find((issue) => issue.title === "Fix it")!;
    await host.harness.behavior.callAgentTool(
      "town_sling",
      { beadId: bead.id },
      { threadId: mayorId },
    );
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const slingSpawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    expect(slingSpawn.projectId).toBe("proj_cloned_rig");
  });

  it("town_review full mode spawns one reviewer per lens with the phased contract", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const polecatId = await slingFirstBead(host, dir, mayorId);

    const result = await host.harness.behavior.callAgentTool(
      "town_review",
      {
        threadId: polecatId,
        mode: "full",
        persona: "a seasoned, high-level Elixir/Phoenix software engineer",
        criteria: ["security", "performance"],
      },
      { threadId: mayorId },
    );
    expect(String(result)).toContain("Started");
    expect(String(result)).toContain("Review · Add login endpoint · security");
    expect(String(result)).toContain("Review · Add login endpoint · performance");

    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const reviewerSpawns = spawns.slice(-2).map((args) => args[0] as Record<string, unknown>);
    for (const spawn of reviewerSpawns) {
      const prompt = spawn.prompt as string;
      expect(prompt).toContain("a seasoned, high-level Elixir/Phoenix software engineer");
      expect(prompt).toContain("Phase 1 — Find");
      expect(prompt).toContain("Phase 2 — Verify");
      expect(prompt).toContain("Phase 3 — Report");
      expect(prompt).toContain("[HIGH]");
      expect(prompt).toContain("Do not modify files");
      expect(spawn.environment).toEqual({ type: "reuse", environmentId: "env_work_1" });
    }
    expect((reviewerSpawns[0]!.prompt as string)).toContain("Your lens: security");
    expect((reviewerSpawns[1]!.prompt as string)).toContain("Your lens: performance");
  });

  it("town_pr_review mints a dedicated bead and spawns PR reviewers in the rig", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const { origin } = await makeWorktree();
    const rigName = origin.split("/").pop()!;
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: args.projectId === "proj_cloned_rig" ? rigName : "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));
    host.harness.inspection.sdk.stub("projects.create", (args: { name: string }) => ({
      id: "proj_cloned_rig",
      name: args.name,
      kind: "standard",
      sources: [],
    }));

    const result = await host.harness.behavior.callAgentTool(
      "town_pr_review",
      { gitUrl: origin, prNumber: 7, mode: "full", criteria: ["security", "quality"] },
      { threadId: mayorId },
    );
    expect(String(result)).toContain("#7");

    // A dedicated bead exists for the review task, tagged with the rig.
    const issues = await bdList(dir);
    const bead = issues.find((issue) => issue.title === `Review PR #7 of ${rigName}`)!;
    expect(bead.labels).toContain(rigName);

    // Two lens reviewers spawned in the rig project, each linked to the bead.
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const reviewerSpawns = spawns.slice(-2).map((args) => args[0] as Record<string, unknown>);
    for (const spawn of reviewerSpawns) {
      expect(spawn.projectId).toBe("proj_cloned_rig");
      expect((spawn.pluginMetadata as Record<string, unknown>).beadId).toBe(bead.id);
      expect(spawn.environment).toMatchObject({
        type: "host",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      });
      const prompt = spawn.prompt as string;
      expect(prompt).toContain("gh pr checkout 7");
      expect(prompt).toContain("gh pr diff 7");
      expect(prompt).toContain("Do not modify files");
    }

    // The reviewer threads carry the bead, so their reports land on it.
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string; beadId: string | null; title: string }[];
    };
    const reviewers = status.threads.filter((thread) => thread.title.startsWith("PR review"));
    expect(reviewers).toHaveLength(2);
    for (const reviewer of reviewers) {
      expect(reviewer.beadId).toBe(bead.id);
    }
  });

  it("town_buzzard and town_imperator dispatch patrols with role briefs", async () => {
    const { host, mayorId } = await makeLedgerHost();
    await host.harness.behavior.callRpc("rigAdd", { projectId: "proj_rig" });

    const buzzard = await host.harness.behavior.callAgentTool(
      "town_buzzard",
      { rigProjectId: "proj_rig", includeUnmaintained: true },
      { threadId: mayorId },
    );
    expect(String(buzzard)).toContain("Buzzard dispatched to authify");
    let spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const buzzardSpawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    expect(buzzardSpawn.role ?? (buzzardSpawn.pluginMetadata as Record<string, string>).role).toBe("buzzard");
    let prompt = buzzardSpawn.prompt as string;
    expect(prompt).toContain("You are a Buzzard");
    expect(prompt).toContain("gh pr create --draft");
    expect(prompt).toContain("Never open a ready (non-draft) pull request");
    expect(prompt).toContain("Unmaintained dependencies");

    const imperator = await host.harness.behavior.callAgentTool(
      "town_imperator",
      { rigProjectId: "proj_rig" },
      { threadId: mayorId },
    );
    expect(String(imperator)).toContain("Imperator dispatched");
    spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const imperatorSpawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    prompt = imperatorSpawn.prompt as string;
    expect(prompt).toContain("You are an Imperator");
    expect(prompt).toContain("Do not create issues. Do not create pull requests.");
    expect(prompt).toContain("Report ONLY to the Mayor");

    // Patrol threads are role-gated like polecats: report tool only.
    const status = (await host.harness.behavior.callRpc("status", null)) as {
      threads: { threadId: string; role: string }[];
    };
    const imperatorThread = status.threads.find((thread) => thread.role === "imperator")!;
    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: imperatorThread.threadId } }),
    );
    expect(configuration.tools.map((tool: { name: string }) => tool.name)).toEqual(["polecat_report"]);
    expect(configuration.instructions).toContain("Imperator");

    // A second dispatch while the first is active skips instead of piling up.
    const again = await host.harness.behavior.callAgentTool(
      "town_imperator",
      { rigProjectId: "proj_rig" },
      { threadId: mayorId },
    );
    expect(String(again)).toContain("already patrolling");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawns.length);
  });

  it("scheduled patrol sweeps dispatch one patrol per rig", async () => {
    const host = createFakePluginHost({
      pluginId: "madmax",
      agentSkillIds: ["mayor", "polecat"],
      settings: { imperatorCron: "0 3 * * *" },
    });
    hosts.push(host);
    await plugin(host.bb);
    const dir = await mkdtemp(join(tmpdir(), "madmax-patrol-"));
    await execFileAsync("bd", ["init"], { cwd: dir, timeout: 120_000 });
    host.harness.inspection.sdk.stub("threadSections.list", () => []);
    host.harness.inspection.sdk.stub("threadSections.create", () => ({ id: "sec_town", name: "Town" }));
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: args.projectId === "proj_rig" ? "authify" : "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));
    host.harness.inspection.sdk.stub("hosts.list", () => [{ id: "host_1", status: "connected" }]);
    let counter = 0;
    host.harness.inspection.sdk.stub("threads.spawn", () =>
      makeThreadResponse({ id: `thr_patrol_${counter++}`, status: "starting" }));
    host.harness.inspection.sdk.stub("threads.send", () => ({ ok: true }));
    await host.harness.behavior.setSettings({ townProject: "proj_town" });
    await host.harness.behavior.callRpc("start", { projectId: "proj_town" });
    await host.harness.behavior.callRpc("rigAdd", { projectId: "proj_rig" });

    await host.harness.behavior.runSchedule("imperator-patrol");

    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const patrolSpawns = spawns.map((args) => args[0] as Record<string, unknown>);
    expect(
      patrolSpawns.some((spawn) => (spawn.prompt as string).includes("You are an Imperator")),
    ).toBe(true);
  });

  it("town_adopt_pr mints a maintenance bead and spawns a maintainer", async () => {
    const { host, dir, mayorId } = await makeLedgerHost();
    const { origin } = await makeWorktree();
    const rigName = origin.split("/").pop()!;
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: args.projectId === "proj_cloned_rig" ? rigName : "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));
    host.harness.inspection.sdk.stub("projects.create", (args: { name: string }) => ({
      id: "proj_cloned_rig",
      name: args.name,
      kind: "standard",
      sources: [],
    }));

    const result = await host.harness.behavior.callAgentTool(
      "town_adopt_pr",
      { gitUrl: origin, prNumber: 7 },
      { threadId: mayorId },
    );
    expect(String(result)).toContain(`Adopted PR ${rigName}#7`);

    // A dedicated maintenance bead exists, tagged with the rig.
    const issues = await bdList(dir);
    const bead = issues.find((issue) => issue.title === `Maintain PR #7 of ${rigName}`)!;
    expect(bead.labels).toContain(rigName);

    // The maintainer spawned in the rig, linked to the bead, with the
    // maintenance brief: checkout authorized, posting forbidden, clean text.
    const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
    const spawn = spawns[spawns.length - 1]![0] as Record<string, unknown>;
    expect(spawn.projectId).toBe("proj_cloned_rig");
    expect((spawn.pluginMetadata as Record<string, unknown>).beadId).toBe(bead.id);
    expect(spawn.environment).toMatchObject({
      type: "host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    const prompt = spawn.prompt as string;
    expect(prompt).toContain("gh pr checkout 7");
    expect(prompt).toContain("Push commits to the pull request branch");
    expect(prompt).toContain("Do not post comments, reviews, or approvals. Do not merge.");
    expect(prompt).toContain("No internal vocabulary");
  });

  it("ledgerInit initializes a bare town checkout", async () => {
    const host = createFakePluginHost({ pluginId: "madmax", agentSkillIds: ["mayor", "polecat"] });
    hosts.push(host);
    await plugin(host.bb);
    const dir = await mkdtemp(join(tmpdir(), "madmax-bare-"));
    host.harness.inspection.sdk.stub("projects.get", (args: { projectId: string }) => ({
      id: args.projectId,
      name: "MyTown",
      kind: "standard",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
      sources: [
        {
          id: "src_1", projectId: args.projectId, hostId: "host_1",
          isDefault: true, path: dir, type: "local_path", createdAt: 0, updatedAt: 0,
        },
      ],
    }));
    await host.harness.behavior.setSettings({ townProject: "proj_town" });

    const before = (await host.harness.behavior.callRpc("status", null)) as {
      ledger: { initialized: boolean } | null;
    };
    expect(before.ledger?.initialized).toBe(false);

    const result = (await host.harness.behavior.callRpc("ledgerInit", {})) as {
      initialized: boolean;
      path: string;
    };
    expect(result.initialized).toBe(true);
    expect(result.path).toBe(dir);
    expect(existsSync(join(dir, ".beads"))).toBe(true);

    const after = (await host.harness.behavior.callRpc("status", null)) as {
      ledger: { initialized: boolean; path: string | null } | null;
    };
    expect(after.ledger?.initialized).toBe(true);
    expect(after.ledger?.path).toBe(dir);
  });
});
