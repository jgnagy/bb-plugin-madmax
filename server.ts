// bb-plugin-madmax — the town backend.
//
// madmax runs a Gas Town on bb: one Mayor thread in the town project
// coordinates polecat worker threads across every registered rig project.
// Work items are self-contained briefs today; Phase 2 links them to the
// Beads (bd) ledger. This plugin never keeps a parallel work ledger —
// plugin storage holds only the thread↔work mapping, the rig registry,
// and the durable alert outbox.
//
// Patterns adapted from Chief for BB (MIT, github.com/divyesh-puri/bb-plugin-chief):
// role-gated agent tools, visible threads in a sidebar section, managed-worktree
// spawning, reconciliation that trusts live thread state, and the alert outbox.
// Conventions adapted from the ghostex "madmax" town skill: GUPP/MEOW/NDI,
// the brief template, model tiers, escalation, and the never-commit-to-main law.
import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const SECTION_NAME = "Town";
const RULES_FILE = "town.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);
const REALTIME_CHANNEL = "town-changed";

const roleSchema = z.enum(["mayor", "polecat", "reviewer"]);
const stateSchema = z.enum([
  "starting",
  "pending",
  "active",
  "stopping",
  "idle",
  "ready",
  "blocked",
  "failed",
  "archived",
  "deleted",
  "complete",
]);
const tierSchema = z.enum(["simplest", "small", "medium", "difficult", "mostDifficult"]);
type Tier = z.infer<typeof tierSchema>;
const DEFAULT_TIER: Tier = "difficult";
const reasoningOptions = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
const permissionModes = ["accept-edits", "auto", "full"] as const;
type SpawnPermissionMode = (typeof permissionModes)[number];

const managedThreadSchema = z.object({
  threadId: z.string(),
  role: roleSchema,
  projectId: z.string(),
  mayorThreadId: z.string().nullable(),
  beadId: z.string().nullable(),
  tier: tierSchema.nullable(),
  title: z.string(),
  state: stateSchema,
  status: z.string().nullable(),
  result: z.string().nullable(),
  blocker: z.string().nullable(),
  recommendation: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ManagedThread = z.infer<typeof managedThreadSchema>;

const rigSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  registeredAt: z.number(),
});
export type Rig = z.infer<typeof rigSchema>;

const slingParams = z.object({
  title: z.string().trim().min(1).max(160).describe("Exact concise title for the polecat thread."),
  mission: z.string().trim().min(1).max(12_000).describe("What to do, why, and what done looks like — self-contained."),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  context: z.string().trim().max(12_000).optional(),
  tier: tierSchema.optional().describe("Model tier for this work item; defaults to 'difficult'."),
  rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project to work in; defaults to the town project (town work)."),
});

const optionalReport = z.object({
  state: z.enum(["active", "idle", "failed"]),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const readyReport = z.object({
  state: z.literal("ready"),
  result: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const blockedReport = z.object({
  state: z.literal("blocked"),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.string().trim().min(1).max(4_000),
  recommendation: z.string().trim().min(1).max(4_000),
});
const reportParams = z.discriminatedUnion("state", [optionalReport, readyReport, blockedReport]);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      sectionId: z.string().nullable(),
      townProjectId: z.string().nullable(),
      mayor: managedThreadSchema.nullable(),
      threads: z.array(managedThreadSchema),
      rigs: z.array(rigSchema),
    }),
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  rigAdd: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: rigSchema.strict(),
  },
  rigRemove: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  projectsList: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ projectId: z.string(), name: z.string(), kind: z.string() }).strict()),
    }).strict(),
  },
  chooseTown: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  createTown: {
    input: z
      .object({
        name: z.string().trim().min(1).max(160),
        path: z.string().trim().min(1),
        hostId: z.string().trim().min(1).optional(),
      })
      .strict(),
    output: z.object({ projectId: z.string(), threadId: z.string(), created: z.boolean() }).strict(),
  },
});

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  project_id: string;
  mayor_thread_id: string | null;
  bead_id: string | null;
  tier: Tier | null;
  title: string;
  state: z.infer<typeof stateSchema>;
  status: string | null;
  result: string | null;
  blocker: string | null;
  recommendation: string | null;
  active_since: number | null;
  active_cycle: number;
  stall_alerted_cycle: number | null;
  created_at: number;
  updated_at: number;
}

interface RigRow {
  project_id: string;
  name: string;
  registered_at: number;
}

interface AlertRow {
  dedupe_key: string;
  target_thread_id: string;
  source_thread_id: string;
  message: string;
  delivered_at: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

const BUILT_IN_RULES = `# Town operating rules

- GUPP: a polecat with a brief runs it autonomously. Sling self-contained briefs; do not hover over working threads.
- MEOW: decompose goals into single, self-contained work items before slinging. Never sling a goal-shaped brief.
- NDI: agents are nondeterministic. Trust nothing unverified; inspect evidence before acting on a report.
- Escalation flows polecat → Mayor → owner. Resolve what you can from settled decisions; bring the owner only genuine product decisions, credentials, external accounts, and irreversible actions.
- Absolute law: never commit to or merge a repo's main/default branch without the owner's explicit say-so.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark work complete; let the owner archive it.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    const next = argv[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? (index++, next) : "true");
    flags.set(name!, [...(flags.get(name!) ?? []), value]);
  }
  return {
    positional,
    one: (name: string) => flags.get(name)?.[0],
    all: (name: string) => flags.get(name) ?? [],
    bool: (name: string) => flags.get(name)?.[0] === "true",
  };
}

function clip(value: string, limit = MAX_ALERT_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function bullets(values?: string[]) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None stated.";
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("madmax town backend loaded");

  const settings = bb.settings.define({
    townProject: { type: "project", label: "Town project (holds the Mayor and the ledger)" },
    mayorProvider: { type: "string", label: "Mayor provider", default: "" },
    mayorModel: { type: "string", label: "Mayor model", default: "" },
    mayorReasoning: { type: "select", label: "Mayor reasoning", options: [...reasoningOptions], default: "high" },
    polecatPermissionMode: {
      type: "select",
      label: "Polecat permission mode",
      options: [...permissionModes],
      default: "accept-edits",
    },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "30" },
    simplestProvider: { type: "string", label: "Simplest tier — provider (trivial, zero-budget work)", default: "" },
    simplestModel: { type: "string", label: "Simplest tier — model", default: "" },
    simplestReasoning: { type: "select", label: "Simplest tier — reasoning", options: [...reasoningOptions], default: "high" },
    smallProvider: { type: "string", label: "Small tier — provider (lookups, single-file changes)", default: "" },
    smallModel: { type: "string", label: "Small tier — model", default: "" },
    smallReasoning: { type: "select", label: "Small tier — reasoning", options: [...reasoningOptions], default: "high" },
    mediumProvider: { type: "string", label: "Medium tier — provider (multi-file features)", default: "" },
    mediumModel: { type: "string", label: "Medium tier — model", default: "" },
    mediumReasoning: { type: "select", label: "Medium tier — reasoning", options: [...reasoningOptions], default: "high" },
    difficultProvider: { type: "string", label: "Difficult tier — provider (the default: tricky logic)", default: "" },
    difficultModel: { type: "string", label: "Difficult tier — model", default: "" },
    difficultReasoning: { type: "select", label: "Difficult tier — reasoning", options: [...reasoningOptions], default: "high" },
    mostDifficultProvider: { type: "string", label: "Most-difficult tier — provider (adversarial, security-sensitive)", default: "" },
    mostDifficultModel: { type: "string", label: "Most-difficult tier — model", default: "" },
    mostDifficultReasoning: { type: "select", label: "Most-difficult tier — reasoning", options: [...reasoningOptions], default: "high" },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rigs (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS town_threads (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('mayor','polecat','reviewer')),
      project_id TEXT NOT NULL,
      mayor_thread_id TEXT,
      bead_id TEXT,
      tier TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS town_threads_mayor ON town_threads (mayor_thread_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS town_threads_project ON town_threads (project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS alert_outbox (
      dedupe_key TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS alert_outbox_pending ON alert_outbox (delivered_at, created_at)`,
  ]);

  const allRows = db.prepare(`SELECT * FROM town_threads ORDER BY created_at ASC`);
  const activeMayor = db.prepare(
    `SELECT * FROM town_threads WHERE role='mayor' AND state NOT IN ('failed','deleted','archived','complete') ORDER BY created_at DESC LIMIT 1`,
  );
  const latestMayor = db.prepare(
    `SELECT * FROM town_threads WHERE role='mayor' ORDER BY created_at DESC LIMIT 1`,
  );
  const allRigs = db.prepare(`SELECT * FROM rigs ORDER BY registered_at ASC`);
  const rigById = db.prepare<[string]>(`SELECT * FROM rigs WHERE project_id=?`);
  const pendingAlerts = db.prepare(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT 100`,
  );

  let roles = new Map<string, ManagedRow>();
  const rulesCache = new Map<string, string>();
  const alertDeliveries = new Map<string, Promise<boolean>>();
  const mayorStarts = new Map<string, Promise<{ threadId: string; created: boolean }>>();

  function reloadRoles() {
    roles = new Map((allRows.all() as ManagedRow[]).map((row) => [row.thread_id, row]));
  }
  reloadRoles();

  function publishTown() {
    bb.realtime.publish(REALTIME_CHANNEL, null);
  }

  function toManaged(row: ManagedRow): ManagedThread {
    return {
      threadId: row.thread_id,
      role: row.role,
      projectId: row.project_id,
      mayorThreadId: row.mayor_thread_id,
      beadId: row.bead_id,
      tier: row.tier,
      title: row.title,
      state: row.state,
      status: row.status,
      result: row.result,
      blocker: row.blocker,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function insertThread(input: {
    threadId: string;
    role: ManagedRow["role"];
    projectId: string;
    mayorThreadId?: string | null;
    beadId?: string | null;
    tier?: Tier | null;
    title: string;
    state?: ManagedRow["state"];
    status?: string | null;
  }) {
    const now = Date.now();
    db.prepare(`INSERT INTO town_threads (
      thread_id, role, project_id, mayor_thread_id, bead_id, tier, title,
      state, status, active_since, active_cycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      mayor_thread_id=excluded.mayor_thread_id, bead_id=excluded.bead_id, tier=excluded.tier,
      title=excluded.title, state=excluded.state, status=excluded.status, updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.mayorThreadId ?? null,
      input.beadId ?? null, input.tier ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.state === "active" ? now : null,
      input.state === "active" ? 1 : 0, now, now,
    );
    reloadRoles();
    publishTown();
  }

  let sectionEnsuring: Promise<string> | null = null;
  async function ensureSection(): Promise<string> {
    if (sectionEnsuring) return sectionEnsuring;
    sectionEnsuring = (async () => {
      const sections = await bb.sdk.threadSections.list();
      let section = sections.find((candidate) => candidate.name === SECTION_NAME);
      if (!section) section = await bb.sdk.threadSections.create({ name: SECTION_NAME });
      db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('section_id', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(section.id);
      return section.id;
    })();
    try {
      return await sectionEnsuring;
    } finally {
      sectionEnsuring = null;
    }
  }

  function storedSectionId() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='section_id'`).get() as { value: string } | undefined)?.value ?? null;
  }

  async function readRules(projectId: string) {
    const cached = rulesCache.get(projectId);
    if (cached) return cached;
    try {
      const file = await bb.sdk.projects.fileContent({ projectId, path: RULES_FILE });
      const content = file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
      const rules = clip(content.trim() || BUILT_IN_RULES, 32_000);
      rulesCache.set(projectId, rules);
      return rules;
    } catch {
      rulesCache.set(projectId, BUILT_IN_RULES);
      return BUILT_IN_RULES;
    }
  }

  async function projectName(projectId: string) {
    try { return (await bb.sdk.projects.get({ projectId })).name; }
    catch { return projectId; }
  }

  function tierExecution(values: Awaited<ReturnType<typeof settings.get>>, tier: Tier) {
    const providerId = values[`${tier}Provider`] as string | undefined;
    const model = values[`${tier}Model`] as string | undefined;
    const reasoningLevel = values[`${tier}Reasoning`] as string | undefined;
    return {
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
    };
  }

  async function defaultHostId() {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No BB host is registered; a host is required for a managed worktree.");
    return host.id;
  }

  function mayorRow() {
    return (activeMayor.get() as ManagedRow | undefined) ?? null;
  }

  /** The configured town project, falling back to wherever the Mayor runs. */
  async function configuredTownProject(): Promise<string | null> {
    return ((await settings.get()).townProject as string | null) ?? mayorRow()?.project_id ?? null;
  }

  /** First-run persistence: lock in the chosen town project. */
  async function setTownProject(projectId: string) {
    const current = (await settings.get()).townProject as string | null;
    if (current && current !== projectId) {
      throw new Error(
        `townProject is already set to ${current}. To move the town, run: bb plugin config madmax set townProject ${projectId} — then reload the plugin.`,
      );
    }
    if (!current) await settings.experimental_set({ townProject: projectId });
  }

  /** The friendly "where should the town live?" message, with real choices. */
  async function noTownMessage() {
    let listing = "";
    try {
      const projects = await bb.sdk.projects.list();
      const lines = projects.map((project) => `  ${project.name} (${project.id})`);
      listing = lines.length
        ? `\n\nYour bb projects:\n${lines.join("\n")}`
        : "\n\n(No bb projects yet — create one first, or register a fresh folder:)\n  bb madmax init --path <dir> --name <name>";
    } catch {
      // Listing is best-effort; the commands below work regardless.
    }
    return [
      "No town project configured — where should the town live?",
      listing,
      "\n\nPick one:",
      "  bb madmax start --project <proj-id>     # use an existing project",
      "  bb madmax init --path <dir> --name <n>  # register a new folder as the town",
      "  bb plugin config madmax set townProject <proj-id>",
      "…or click Start Mayor on bb's New Thread screen and choose there.",
    ]
      .filter((part) => part !== "")
      .join("\n");
  }

  async function spawnMayor(target: string, previous?: ManagedRow) {
    const values = await settings.get();
    const sectionId = await ensureSection();
    const name = await projectName(target);
    const rules = await readRules(target);
    const title = `Mayor · ${name}`;
    const prompt = [
      `You are the Mayor of ${name} — the town's chief-of-staff agent. You coordinate work across the town's registered rig projects through visible polecat threads.`,
      "",
      "Use town_sling to start one polecat per self-contained work item; choose the model tier honestly (simplest for trivial mechanical work, small for lookups and single-file changes, medium for multi-file features, difficult for tricky logic, mostDifficult for adversarial or security-sensitive work).",
      "Use town_roster for the town's threads. Before deciding, use town_inspect to read a thread's live status, persisted report, and last assistant output. Reports are evidence, not proof.",
      "Use town_nudge to answer a polecat's question or correct course; steer only a thread working something wrong right now.",
      "Polecats report ready or blocked; only you decide when work is verified and complete. Escalate to the owner only genuine product decisions, credentials, external accounts, and irreversible actions — lead with a recommendation and the evidence.",
      "", "## Town rules", rules,
      "", "Acknowledge the rules briefly, inspect the roster, and wait for work.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: { type: "project-default" },
      sectionId,
      visibility: "visible",
      title,
      ...(values.mayorProvider ? { providerId: values.mayorProvider as string } : {}),
      ...(values.mayorModel ? { model: values.mayorModel as string } : {}),
      ...(values.mayorReasoning ? { reasoningLevel: values.mayorReasoning as string } : {}),
      prompt,
    });
    if (previous && previous.thread_id !== thread.id) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE town_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
        db.prepare(`UPDATE town_threads SET mayor_thread_id=?, updated_at=?
          WHERE mayor_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(
          thread.id, now, previous.thread_id,
        );
        db.prepare(`UPDATE alert_outbox SET target_thread_id=?
          WHERE target_thread_id=? AND delivered_at IS NULL`).run(thread.id, previous.thread_id);
      })();
      reloadRoles();
    }
    insertThread({ threadId: thread.id, role: "mayor", projectId: target, title, state: "starting", status: thread.status });
    return { threadId: thread.id, created: true as const };
  }

  async function ensureMayor(projectId?: string) {
    const values = await settings.get();
    const target = projectId ?? values.townProject;
    if (!target) throw new Error(await noTownMessage());
    const inFlight = mayorStarts.get(target);
    if (inFlight) return inFlight;
    const start = (async () => {
      const existing = mayorRow();
      if (existing && existing.project_id === target) {
        await reconcileThread(existing, await ensureSection());
        const reconciled = roles.get(existing.thread_id);
        if (reconciled && !["failed", "deleted", "archived", "complete"].includes(reconciled.state)) {
          return { threadId: existing.thread_id, created: false };
        }
      }
      const previous = latestMayor.get() as ManagedRow | undefined;
      return spawnMayor(target, previous);
    })();
    mayorStarts.set(target, start);
    try {
      return await start;
    } finally {
      mayorStarts.delete(target);
    }
  }

  /** First-run flow: choose the town project, then start its Mayor. */
  async function chooseTown(projectId: string) {
    await setTownProject(projectId);
    return ensureMayor(projectId);
  }

  /** First-run flow: register a folder as a new town project and start it. */
  async function createTown(input: { name: string; path: string; hostId?: string }) {
    const hostId = input.hostId ?? (await defaultHostId());
    const project = await bb.sdk.projects.create({
      name: input.name,
      source: { type: "local_path", hostId, path: input.path },
    });
    const start = await chooseTown(project.id);
    return { projectId: project.id, threadId: start.threadId, created: start.created };
  }

  function isRig(projectId: string) {
    return rigById.get(projectId) !== undefined;
  }

  async function addRig(projectId: string): Promise<Rig> {
    const existing = rigById.get(projectId) as RigRow | undefined;
    if (existing) return { projectId: existing.project_id, name: existing.name, registeredAt: existing.registered_at };
    const name = await projectName(projectId);
    const now = Date.now();
    db.prepare(`INSERT INTO rigs (project_id, name, registered_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET name=excluded.name`).run(projectId, name, now);
    publishTown();
    return { projectId, name, registeredAt: now };
  }

  function removeRig(projectId: string) {
    const result = db.prepare(`DELETE FROM rigs WHERE project_id=?`).run(projectId);
    publishTown();
    return result.changes > 0;
  }

  async function sling(params: z.infer<typeof slingParams>, callerThreadId?: string | null) {
    const caller = callerThreadId ? roles.get(callerThreadId) : undefined;
    const values = await settings.get();
    const townProject = values.townProject as string | null;
    const mayor = caller?.role === "mayor" ? caller : mayorRow();
    if (!mayor || ["complete", "archived", "deleted"].includes(mayor.state)) {
      throw new Error("Start the Mayor for the town before slinging work.");
    }
    const townId = mayor.project_id || townProject;
    if (!townId) throw new Error("No town project is configured.");
    const rigProjectId = params.rigProjectId ?? townId;
    if (rigProjectId !== townId && !isRig(rigProjectId)) {
      throw new Error(`Project ${rigProjectId} is not a registered rig. Register it first: bb madmax rig add ${rigProjectId}`);
    }
    const tier: Tier = params.tier ?? DEFAULT_TIER;
    const sectionId = await ensureSection();
    const townName = await projectName(townId);
    const rigName = rigProjectId === townId ? `${townName} (town work)` : await projectName(rigProjectId);
    const permissionMode = ((values.polecatPermissionMode as SpawnPermissionMode) || "accept-edits");
    const brief = [
      `You are a polecat in the town of ${townName}, working on rig ${rigName}.`,
      "",
      `## Work item`, params.title,
      "", "## Goal", params.mission,
      "", "## Success criteria", bullets(params.successCriteria),
      "", "## Constraints", bullets(params.constraints),
      ...(params.context ? ["", "## Context", params.context] : []),
      "",
      "## Town rules",
      "- Scope: only this work item. Your worktree is your workspace; do not touch other projects, other worktrees, or the town repo.",
      "- Never commit to or merge the main/default branch of any repo.",
      "- Do not push, merge, or delete anything unless your brief asks. Do not post comments or reviews to external services.",
      "- Anything outside your worktree flows through the Mayor: report it, don't do it.",
      "- Keep scope narrow and verify the user journey or the closest executable seam; do not substitute a typecheck for real verification.",
      "",
      "## Reporting",
      "- Use polecat_report with state ready and a non-empty result when your work is ready for the Mayor's verification. A ready result names changed files, checks run, relevant output, residual risks, and the recommended next action.",
      "- Report state blocked only with both a non-empty blocker and your recommended decision or next action.",
      "- You talk to the Mayor, never directly to the owner. Do not ask the user from this thread.",
      "- GUPP: run your brief without waiting.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: rigProjectId,
      environment: {
        type: "host",
        hostId: await defaultHostId(),
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      sectionId,
      visibility: "visible",
      title: params.title,
      permissionMode,
      parentThreadId: mayor.thread_id,
      lifecycleOwnerThreadId: mayor.thread_id,
      parentNotifications: "stuck",
      pluginMetadata: { role: "polecat", tier, rig: rigProjectId, town: townId, beadId: null },
      ...tierExecution(values, tier),
      prompt: brief,
    });
    insertThread({
      threadId: thread.id, role: "polecat", projectId: rigProjectId,
      mayorThreadId: mayor.thread_id, tier, title: params.title,
      state: "starting", status: thread.status,
    });
    return { threadId: thread.id, title: params.title, projectId: rigProjectId, tier };
  }

  async function nudge(threadId: string, text: string, steer = false) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error(`No managed polecat or reviewer ${threadId}.`);
    await bb.sdk.threads.send({
      threadId,
      mode: steer ? "steer-if-active" : "queue-if-active",
      input: [{ type: "text", text: clip(text, MAX_RESULT_LENGTH), mentions: [] }],
      senderThreadId: row.mayor_thread_id ?? undefined,
    });
    db.prepare(`UPDATE town_threads SET state='active', blocker=NULL, recommendation=NULL,
      active_since=?, active_cycle=active_cycle+1, stall_alerted_cycle=NULL, updated_at=? WHERE thread_id=?`).run(
      Date.now(), Date.now(), threadId,
    );
    reloadRoles();
    publishTown();
    return roles.get(threadId)!;
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string) {
    const target = row.role === "mayor" ? row.thread_id : row.mayor_thread_id;
    if (!target) throw new Error(`Managed thread ${row.thread_id} has no Mayor to notify.`);
    db.prepare(`INSERT OR IGNORE INTO alert_outbox
      (dedupe_key, target_thread_id, source_thread_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      `${row.thread_id}:${key}`, target, row.thread_id,
      clip(`[Town lifecycle alert]\n${message}`), Date.now(),
    );
    return `${row.thread_id}:${key}`;
  }

  async function deliverAlert(key: string) {
    const existing = alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      try {
        await bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          mode: "queue-if-active",
          input: [{ type: "text", text: clip(alert.message), mentions: [] }],
        });
        db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`UPDATE alert_outbox SET attempts=attempts+1, last_error=? WHERE dedupe_key=?`).run(clip(message, 1_000), key);
        bb.log.warn(`Could not deliver town alert ${key}: ${message}`);
        return false;
      }
    })();
    alertDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      alertDeliveries.delete(key);
    }
  }

  async function alertMayor(row: ManagedRow, key: string, message: string) {
    const outboxKey = enqueueAlert(row, key, message);
    return deliverAlert(outboxKey);
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all() as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }

  async function report(threadId: string, params: z.infer<typeof reportParams>) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error("polecat_report is available only in managed polecat and reviewer threads.");
    if (["complete", "archived", "deleted"].includes(row.state)) {
      throw new Error(`Managed thread ${threadId} is ${row.state} and can no longer report.`);
    }
    const now = Date.now();
    db.prepare(`UPDATE town_threads SET state=?, result=?, blocker=?, recommendation=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      params.state, params.result ?? null, params.state === "blocked" ? params.blocker : null,
      params.recommendation ?? null, now, threadId,
    );
    reloadRoles();
    publishTown();
    const current = roles.get(threadId)!;
    const summary = [
      `${row.role === "reviewer" ? "Reviewer" : "Polecat"} report from ${row.title} (${threadId})`,
      `State: ${params.state}`,
      ...(params.result ? [`Result: ${params.result}`] : []),
      ...(params.state === "blocked" ? [`Blocker: ${params.blocker}`] : []),
      ...(params.recommendation ? [`Recommendation: ${params.recommendation}`] : []),
      "Inspect live evidence with town_inspect and choose: nudge, verify, complete, or escalate to the owner.",
    ].join("\n");
    const delivered = await alertMayor(current, `report:${now}:${randomUUID()}`, summary);
    if (!delivered) {
      throw new Error("Report was saved but could not be delivered to the Mayor. It will retry automatically; check Mayor connectivity before reporting again.");
    }
    return current;
  }

  async function inspect(threadId: string) {
    const row = roles.get(threadId);
    if (!row) throw new Error(`No managed thread ${threadId}.`);
    let liveStatus = row.status;
    try {
      const live = await bb.sdk.threads.get({ threadId });
      liveStatus = live.deletedAt !== null ? "deleted" : live.archivedAt !== null ? "archived" : live.status;
    } catch (error) {
      bb.log.warn(`Could not inspect live status for ${threadId}: ${String(error)}`);
    }
    let output: string | null = null;
    try {
      output = (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
    }
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      `Project: ${row.project_id}`,
      `Tier: ${row.tier ?? "—"}`,
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.result ? [`Result: ${clip(row.result, 2_000)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 1_000)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 1_000)}`] : []),
      `Last assistant output:\n${output ? clip(output, 4_000) : "(none available)"}`,
    ].join("\n");
  }

  function stateFromLive(row: ManagedRow, status: string) {
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    return "idle";
  }

  async function reconcileThread(row: ManagedRow, sectionId: string) {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    } catch (error) {
      bb.log.warn(`Transient thread read failure for ${row.thread_id}; will retry: ${String(error)}`);
      return false;
    }
    const now = Date.now();
    if (thread.deletedAt !== null) {
      db.prepare(`UPDATE town_threads SET state='deleted', status=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, row.thread_id);
      reloadRoles();
      publishTown();
      return true;
    }
    if (thread.archivedAt !== null) {
      db.prepare(`UPDATE town_threads SET state='archived', status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(thread.status, now, row.thread_id);
      reloadRoles();
      publishTown();
      return true;
    }
    if (thread.sectionId !== sectionId || thread.visibility !== "visible") {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, sectionId, visibility: "visible" });
      } catch (error) {
        bb.log.warn(`Transient thread filing failure for ${row.thread_id}; will retry: ${String(error)}`);
      }
    }
    const nextState = stateFromLive(row, thread.status) as ManagedRow["state"];
    const enteringActive = nextState === "active" && row.state !== "active";
    db.prepare(`UPDATE town_threads SET state=?, status=?, active_since=?,
      active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
      updated_at=? WHERE thread_id=?`).run(
      nextState, thread.status,
      nextState === "active" ? (row.state === "active" ? row.active_since ?? now : now) : null,
      enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, row.thread_id,
    );
    reloadRoles();
    return true;
  }

  async function reconcile() {
    const sectionId = await ensureSection();
    for (const row of [...roles.values()]) {
      if (row.state !== "deleted") await reconcileThread(row, sectionId);
    }
    const projects = new Set(
      [...allRigs.all() as RigRow[]].map((row) => row.project_id).concat(
        [...roles.values()].map((row) => row.project_id),
      ),
    );
    const town = (await settings.get()).townProject as string | null;
    if (town) projects.add(town);
    for (const projectId of projects) await readRules(projectId);
  }

  async function lifecycle(kind: string, thread: { id: string; status?: string }, detail?: string | null) {
    const row = roles.get(thread.id);
    if (!row) return;
    const now = Date.now();
    if (row.role === "mayor") {
      const state = kind === "active" ? "active"
        : kind === "idle" || kind === "unarchived" ? "idle"
          : kind === "failed" ? "failed"
            : kind === "archived" ? "archived" : "deleted";
      db.prepare(`UPDATE town_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
        state, thread.status ?? state, now, row.thread_id,
      );
      reloadRoles();
      publishTown();
      return;
    }
    if (kind === "active") {
      const enteringActive = row.state !== "active";
      db.prepare(`UPDATE town_threads SET state='active', status=?, active_since=?,
        active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
        updated_at=? WHERE thread_id=?`).run(
        thread.status ?? "active", enteringActive ? now : row.active_since ?? now,
        enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, row.thread_id,
      );
      reloadRoles();
      publishTown();
      return;
    }
    if (kind === "unarchived") {
      // A polecat came back from the archive (owner or patrol restored it).
      const state = ["ready", "blocked", "complete"].includes(row.state) ? row.state : "idle";
      db.prepare(`UPDATE town_threads SET state=?, status=?, updated_at=? WHERE thread_id=?`).run(
        state, thread.status ?? "idle", now, row.thread_id,
      );
      reloadRoles();
      publishTown();
      return;
    }
    const observed = kind === "idle" ? "idle" : kind === "failed" ? "failed" : kind === "archived" ? "archived" : "deleted";
    const state = observed === "idle" && ["ready", "blocked", "complete"].includes(row.state) ? row.state : observed;
    db.prepare(`UPDATE town_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      state, thread.status ?? observed, now, row.thread_id,
    );
    reloadRoles();
    publishTown();
    const current = roles.get(row.thread_id)!;
    await alertMayor(current, `${kind}:${row.active_cycle}`, [
      `${current.role} “${current.title}” (${current.thread_id}) is ${observed}.`,
      ...(detail ? [`Detail: ${detail}`] : []),
      "Inspect live output and evidence. Choose a safe next step: nudge it, verify and complete it, or escalate a genuine decision to the owner.",
    ].join("\n"));
  }

  bb.events.on("thread.active", ({ thread }) => lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => lifecycle("idle", thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => lifecycle("failed", thread, error));
  bb.events.on("thread.archived", ({ thread }) => lifecycle("archived", thread));
  bb.events.on("thread.unarchived", ({ thread }) => lifecycle("unarchived", thread));
  bb.events.on("thread.deleted", ({ thread }) => lifecycle("deleted", thread));

  bb.background.service("deacon", {
    async start(signal) {
      const wake = () => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, RECONCILE_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
      });
      while (!signal.aborted) {
        try {
          await reconcile();
          const values = await settings.get();
          const parsed = Number(values.stallMinutes);
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 30) * 60_000;
          const now = Date.now();
          for (const row of [...roles.values()]) {
            if (row.role === "mayor" || row.state !== "active" || row.active_since === null) continue;
            if (now - row.active_since < threshold || row.stall_alerted_cycle === row.active_cycle) continue;
            const sent = await alertMayor(row, `stall:${row.active_cycle}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has remained active for more than ${Math.round(threshold / 60_000)} minutes.`,
              "Inspect current evidence before intervening. Nudge only when a safe next instruction is clear; otherwise escalate the concrete blocker.",
            ].join("\n"));
            if (sent) {
              db.prepare(`UPDATE town_threads SET stall_alerted_cycle=?, updated_at=? WHERE thread_id=?`).run(row.active_cycle, Date.now(), row.thread_id);
              reloadRoles();
            }
          }
          const mayorTerminal =
            [...roles.values()].some((row) => row.role === "mayor" && ["failed", "archived", "deleted"].includes(row.state));
          if (mayorTerminal && ((await settings.get()).townProject as string | null)) {
            await ensureMayor();
          }
          await retryAlerts();
        } catch (error) {
          bb.log.warn(`Deacon reconciliation failed: ${String(error)}`);
        }
        await wake();
      }
    },
  });

  settings.onChange((next, previous) => {
    if (next.townProject && next.townProject !== previous.townProject) {
      void ensureMayor(next.townProject as string).catch((error) => bb.log.warn(`Could not auto-start the Mayor: ${String(error)}`));
    }
  });

  function belongsToMayor(row: ManagedRow, mayorThreadId: string) {
    return row.thread_id === mayorThreadId || row.mayor_thread_id === mayorThreadId;
  }

  function rosterForMayor(mayorThreadId: string, includeComplete = false) {
    return [...roles.values()].filter(
      (row) => belongsToMayor(row, mayorThreadId) && row.role !== "mayor" && (includeComplete || row.state !== "complete"),
    );
  }

  bb.agents.registerTool({
    name: "town_sling",
    description: "Sling one clearly titled, self-contained work item to a polecat worker thread in its own managed worktree.",
    parameters: slingParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_sling requires an active registered Mayor thread.");
      }
      const result = await sling(params, context.threadId);
      return `Slung “${result.title}” to a polecat in thread ${result.threadId} (tier ${result.tier}, project ${result.projectId}). Track it with town_roster.`;
    },
  });
  bb.agents.registerTool({
    name: "town_roster",
    description: "List the town's managed threads with their persisted state and latest reports.",
    parameters: z.object({ includeComplete: z.boolean().optional() }),
    async execute({ includeComplete }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor") throw new Error("town_roster requires a registered Mayor thread.");
      const rows = rosterForMayor(caller.thread_id, includeComplete);
      return rows.length ? rows.map((row) => [
        `${row.role} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
        ...(row.result ? [`result: ${clip(row.result, 1_000)}`] : []),
        ...(row.blocker ? [`blocker: ${clip(row.blocker, 600)}`] : []),
        ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 600)}`] : []),
      ].join("\n  ")).join("\n") : "No managed threads in the town yet.";
    },
  });
  bb.agents.registerTool({
    name: "town_inspect",
    description: "Inspect one managed thread's live status, persisted report, and bounded last assistant output before deciding.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Mayor.`);
      }
      return inspect(threadId);
    },
  });
  bb.agents.registerTool({
    name: "town_nudge",
    description: "Send a self-contained instruction to a managed polecat. Steer only to interrupt a thread working something wrong right now.",
    parameters: z.object({
      threadId: z.string(),
      text: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
      steer: z.boolean().optional().describe("Interrupt the running turn instead of queuing behind it."),
    }),
    async execute({ threadId, text, steer }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Mayor.`);
      }
      await nudge(threadId, text, steer);
      return `Nudged ${threadId}${steer ? " (steering the running turn)" : " (queued)"}.`;
    },
  });
  bb.agents.registerTool({
    name: "polecat_report",
    description: "Report managed work state and evidence to the Mayor. Use ready, not complete; blocked requires blocker and recommendation.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("polecat_report requires a thread context.");
      await report(context.threadId, params);
      return "Report delivered to the Mayor.";
    },
  });

  bb.agents.configure((context) => {
    const row = roles.get(context.thread.id);
    const role = row?.role ?? (context.pluginMetadata.role === "mayor" || context.pluginMetadata.role === "polecat" || context.pluginMetadata.role === "reviewer"
      ? context.pluginMetadata.role
      : undefined);
    if (!role || (row && ["complete", "archived", "deleted"].includes(row.state))) {
      return { tools: [], skills: [] };
    }
    const rules = row ? (rulesCache.get(row.project_id) ?? BUILT_IN_RULES) : BUILT_IN_RULES;
    if (role === "mayor") {
      return {
        tools: ["town_sling", "town_roster", "town_inspect", "town_nudge"],
        skills: ["mayor"],
        instructions: `You are the registered Mayor supervising the town's polecat threads from ${context.project.name}.\n\n${rules}`,
      };
    }
    return {
      tools: ["polecat_report"],
      skills: ["polecat"],
      instructions: `You are a managed ${role} reporting to the Mayor of this town.\n\n${rules}`,
    };
  });

  bb.rpc.register(rpcContract, {
    status: async () => {
      const mayor = mayorRow();
      return {
        sectionId: storedSectionId(),
        townProjectId: await configuredTownProject(),
        mayor: mayor ? toManaged(mayor) : null,
        threads: [...roles.values()].map(toManaged),
        rigs: (allRigs.all() as RigRow[]).map((row) => ({ projectId: row.project_id, name: row.name, registeredAt: row.registered_at })),
      };
    },
    start: ({ projectId }) => ensureMayor(projectId ?? undefined),
    rigAdd: ({ projectId }) => addRig(projectId),
    rigRemove: ({ projectId }) => ({ removed: removeRig(projectId) }),
    projectsList: async () => ({
      projects: (await bb.sdk.projects.list()).map((project) => ({
        projectId: project.id,
        name: project.name,
        kind: project.kind,
      })),
    }),
    chooseTown: ({ projectId }) => chooseTown(projectId),
    createTown: (input) => createTown(input),
  });

  const usage = [
    "Usage:",
    "  bb madmax status [--json]",
    "  bb madmax start [--project <proj-id>] [--json]",
    "  bb madmax init --project <proj-id>",
    "  bb madmax init --path <dir> --name <name> [--host <host-id>]",
    "  bb madmax rig list [--json]",
    "  bb madmax rig add <project-id>",
    "  bb madmax rig remove <project-id>",
    "  bb madmax sling --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--rig <project-id>] [--tier <tier>] [--json]",
    "  bb madmax nudge <thread-id> --text \"…\" [--steer] [--json]",
    "  bb madmax inspect <thread-id>",
  ].join("\n");

  bb.cli.register({
    name: "madmax",
    summary: "Run the town: a Mayor that slings work to polecat threads across rigs",
    commands: [
      { name: "status", summary: "Show the town's roster", usage: "bb madmax status [--json]" },
      { name: "start", summary: "Start or return the town's Mayor", usage: "bb madmax start [--project <proj-id>] [--json]" },
      { name: "init", summary: "Choose the town project (existing or a new folder) and start the Mayor", usage: "bb madmax init --project <proj-id> | --path <dir> --name <name> [--host <host-id>]" },
      { name: "rig", summary: "Manage registered rig projects", usage: "bb madmax rig list|add|remove" },
      { name: "sling", summary: "Sling a work item to a polecat", usage: "bb madmax sling --title \"…\" --mission \"…\" [--rig <project-id>] [--tier <tier>] [--json]" },
      { name: "nudge", summary: "Nudge a managed polecat", usage: "bb madmax nudge <thread-id> --text \"…\" [--steer] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's evidence", usage: "bb madmax inspect <thread-id>" },
    ],
    async run(argv: string[], context: PluginCliContext): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (data: unknown, text: string) => ({ exitCode: 0, stdout: clip(json ? JSON.stringify(data, null, 2) : text, 64_000) + "\n" });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}\n` });
      try {
        if (!command || command === "help" || command === "--help") return ok({}, usage);
        if (command === "status") {
          const mayor = mayorRow();
          const townProjectId = await configuredTownProject();
          const threads = [...roles.values()].map(toManaged);
          const rigs = (allRigs.all() as RigRow[]).map((row) => ({ projectId: row.project_id, name: row.name, registeredAt: row.registered_at }));
          return ok(
            { sectionId: storedSectionId(), townProjectId, mayor: mayor ? toManaged(mayor) : null, threads, rigs },
            [
              mayor
                ? `Mayor: ${mayor.title} (${mayor.state}) ${mayor.thread_id}`
                : townProjectId
                  ? `Town: ${townProjectId} — no Mayor yet. Run: bb madmax start`
                  : "No town yet. Run: bb madmax init",
              ...threads.filter((row) => row.role !== "mayor").map((row) => `${row.role.padEnd(8)} ${row.state.padEnd(9)} ${row.title}  ${row.threadId}`),
              ...(rigs.length ? [`Rigs: ${rigs.map((rig) => rig.name).join(", ")}`] : []),
            ].join("\n"),
          );
        }
        if (command === "start") {
          const result = await ensureMayor(args.one("project") ?? context.projectId ?? undefined);
          return ok(result, `${result.created ? "Started" : "Using"} Mayor thread ${result.threadId}.`);
        }
        if (command === "init") {
          const projectId = args.one("project");
          const path = args.one("path");
          const name = args.one("name");
          if (projectId) {
            const result = await chooseTown(projectId);
            return ok(result, `Town project ${projectId}: ${result.created ? "started" : "using"} Mayor thread ${result.threadId}.`);
          }
          if (path && name) {
            const result = await createTown({ name, path, hostId: args.one("host") });
            return ok(result, `Created town “${name}” (${result.projectId}) and ${result.created ? "started" : "reused"} Mayor thread ${result.threadId}.`);
          }
          return fail("init requires --project <proj-id>, or --path <dir> --name <name> [--host <host-id>]");
        }
        if (command === "rig") {
          const [sub, target] = args.positional;
          if (sub === "list") {
            const rigs = (allRigs.all() as RigRow[]).map((row) => ({ projectId: row.project_id, name: row.name, registeredAt: row.registered_at }));
            return ok({ rigs }, rigs.length ? rigs.map((rig) => `${rig.name.padEnd(20)} ${rig.projectId}`).join("\n") : "No rigs registered.");
          }
          if (sub === "add") {
            const projectId = target ?? args.one("project");
            if (!projectId) return fail("rig add requires <project-id>");
            const rig = await addRig(projectId);
            return ok(rig, `Registered rig “${rig.name}” (${rig.projectId}).`);
          }
          if (sub === "remove") {
            const projectId = target ?? args.one("project");
            if (!projectId) return fail("rig remove requires <project-id>");
            const removed = removeRig(projectId);
            return ok({ removed }, removed ? `Removed rig ${projectId}.` : `No rig ${projectId}.`);
          }
          return fail(`Unknown rig subcommand “${sub}”.`);
        }
        if (command === "sling") {
          const parsed = slingParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            tier: args.one("tier"), rigProjectId: args.one("rig"),
          });
          if (!parsed.success) return fail(`Invalid sling brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          await ensureMayor();
          const result = await sling(parsed.data, context.threadId);
          return ok(result, `Slung “${result.title}” to a polecat in ${result.threadId} (tier ${result.tier}).`);
        }
        if (command === "nudge") {
          const threadId = args.positional[0];
          const text = args.one("text");
          if (!threadId || !text) return fail("nudge requires <thread-id> and --text");
          await nudge(threadId, text, args.bool("steer"));
          return ok({ threadId }, `Nudged ${threadId}.`);
        }
        if (command === "inspect") {
          const threadId = args.positional[0];
          if (!threadId) return fail("inspect requires <thread-id>");
          return ok({ threadId }, await inspect(threadId));
        }
        return fail(`Unknown command “${command}”.`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("madmax town backend disposed");
  });

  try {
    await reconcile();
  } catch (error) {
    bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
}
