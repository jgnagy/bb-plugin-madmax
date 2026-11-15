// bb-plugin-madmax — backend tests against the fake plugin host.
//
// The fake host runs the real server.ts with a process-local SQLite store and
// a recordable bb.sdk: every spawn, section, project, and send call below is a
// stub whose arguments the assertions inspect. No BB server is needed.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
      makeThreadResponse({ id: args.threadId, status: "idle" }));
    await host.harness.behavior.setSettings({ townProject: "proj_town" });
    const started = (await host.harness.behavior.callRpc("start", { projectId: "proj_town" })) as {
      threadId: string;
      created: boolean;
    };
    return { host, dir, mayorId: started.threadId };
  }

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
