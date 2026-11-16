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
// Conventions carried forward from Gas Town: GUPP/MEOW/NDI,
// the brief template, model tiers, escalation, and the never-commit-to-main law.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const SECTION_NAME = "Town";
const RULES_FILE = "town.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);
const REALTIME_CHANNEL = "town-changed";
const BD_TIMEOUT_MS = 60_000;
const LEDGER_CACHE_MS = 5_000;

const roleSchema = z.enum(["mayor", "polecat", "reviewer", "buzzard", "imperator"]);
type PatrolRole = "buzzard" | "imperator";

type Forge = "github" | "gitlab" | "gitea" | null;
type ForgeCli = "gh" | "glab" | "gt" | "tea" | null;

/** A pull/merge request reference found in free text (e.g. a polecat report). */
export interface PrRef {
  url: string;
  number: number;
  forge: Forge;
}

/** Extract PR/MR URLs from free text. Matches github.com, gitlab (any host), gitea/forgejo/codeberg/codeberg\.org — any host, classified by host name. */
export function parsePrUrls(text: string): PrRef[] {
  const found = new Map<string, PrRef>();
  const pattern = /(https?:\/\/[^\s<>()"']+?\/(?:pull|pulls|merge_requests)\/)(\d+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const url = (match[1] ?? "") + (match[2] ?? "");
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    const forge = forgeFromRemote(url);
    if (!found.has(url)) found.set(url, { url, number, forge });
  }
  return [...found.values()];
}

/** Interpret a forge CLI's answer about a PR/MR state. Conservative: null when unsure. */
export function parseForgePrState(output: string): "merged" | "closed" | "open" | null {
  const jsonState = /"state"\s*:\s*"([a-z_]+)"/i.exec(output);
  const state = (jsonState?.[1] ?? (/\b(merged|closed|opened|open|declined|canceled|cancelled)\b/i.exec(output)?.[1] ?? "")).toLowerCase();
  if (!state) return null;
  if (state === "merged") return "merged";
  if (state === "open" || state === "opened") return "open";
  if (["closed", "declined", "canceled", "cancelled"].includes(state)) return "closed";
  return null;
}

/** Pure remote→forge mapping (exported for tests). Matches on the host, never the path. */
export function forgeFromRemote(remoteUrl: string | null): Forge {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim().toLowerCase();
  if (!url) return null;
  let host: string | null = null;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url);
  if (schemeMatch) {
    host = schemeMatch[1] ?? null; // https://[user@]host[:port]/path (also ssh://, git://, file://)
  } else {
    const scpMatch = /^(?:[^@/]+@)?([^/:]+):/.exec(url); // git@host:org/repo.git
    if (scpMatch) host = scpMatch[1] ?? null;
  }
  if (!host) return null;
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("gitea") || host.includes("forgejo") || host.includes("codeberg")) return "gitea";
  return null;
}

/** The name `gt` is ambiguous (gitea-cli, Graphite, ...). Only trust it as Gitea's CLI when it says so. */
export function looksLikeGiteaCli(versionOutput: string): boolean {
  return /gitea/i.test(versionOutput);
}

const FORGE_ALIASES: Record<string, string> = {
  github: "gh",
  gitlab: "glab",
  gitea: "gt",
  forgejo: "gt",
  "gitea-cli": "gt",
};

const execProbe = (bin: string, args: string[]): Promise<string> =>
  execFileAsync(bin, args, { timeout: 5_000 }).then((r) => r.stdout + r.stderr);

/**
 * Resolve the Gitea-family CLI: the official `gt` (gitea-cli, verified by its
 * version banner), else the archived but still-working `tea`. Null when neither works.
 */
export async function detectGiteaCli(
  probe: (bin: string, args: string[]) => Promise<string> = execProbe,
): Promise<"gt" | "tea" | null> {
  try {
    const out = await probe("gt", ["--version"]);
    if (looksLikeGiteaCli(out)) return "gt";
    // `gt` exists but is some other tool (e.g. Graphite) — do not mistake it for Gitea's.
  } catch {
    /* gt not installed or not runnable */
  }
  try {
    await probe("tea", ["--version"]);
    return "tea";
  } catch {
    return null;
  }
}
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
  forge: z.string().nullable(),
  registeredAt: z.number(),
});
export type Rig = z.infer<typeof rigSchema>;

const slingParams = z.object({
  title: z.string().trim().min(1).max(160).optional().describe("Exact concise title for the polecat thread. Optional when beadId is given."),
  mission: z.string().trim().min(1).max(12_000).optional().describe("What to do, why, and what done looks like — self-contained. Optional when beadId is given."),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  context: z.string().trim().max(12_000).optional(),
  tier: tierSchema.optional().describe("Model tier for this work item; defaults to 'difficult'."),
  rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project to work in; defaults to the bead's rig label, else the town project."),
  beadId: z.string().trim().min(1).optional().describe("Bead to sling from the town ledger; its title and description become the brief."),
  openPr: z.boolean().optional().describe("The owner has approved opening a pull request for this work. The polecat pushes its branch and opens the PR when the work is complete."),
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

/** A bd issue as returned by `bd list/show --json` (fields we rely on). */
const beadSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  priority: z.union([z.number(), z.string()]).nullable().optional(),
  issue_type: z.string().nullable().optional(),
  labels: z.array(z.string()).nullable().optional(),
  parent: z.string().nullable().optional(),
  comment_count: z.number().nullable().optional(),
});
export type Bead = z.infer<typeof beadSchema>;

const convoyBeadParams = z.object({
  title: z.string().trim().min(1).max(200).describe("Short, literal bead title."),
  description: z.string().trim().min(1).max(8_000).describe("What + why + done-when — self-contained; a fresh polecat reads only this and the brief."),
  priority: z.number().int().min(0).max(4).optional().describe("0 is highest; default 2."),
  rig: z.string().trim().min(1).optional().describe("Rig label for routing the sling later; defaults to the convoy's rig."),
  dependsOn: z.array(z.number().int().min(0)).max(20).optional().describe("Indices of earlier beads in this convoy that must land first."),
});

const convoyParams = z.object({
  goal: z.string().trim().min(1).max(200).describe("The convoy's goal — becomes the epic's title."),
  description: z.string().trim().max(8_000).optional().describe("Why this convoy exists and what done looks like."),
  rig: z.string().trim().min(1).optional().describe("Rig label applied to every bead in the convoy."),
  beads: z.array(convoyBeadParams).min(1).max(50),
});

const completeParams = z.object({
  threadId: z.string().trim().min(1),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional().describe("The verified outcome recorded on the bead."),
  archive: z.boolean().optional().describe("Archive the thread after completing it so bb collects its worktree. Defaults to true. Pass false to keep it open."),
});

const adoptParams = z.object({
  threadId: z.string().trim().min(1).describe("The existing bb thread to adopt."),
  role: z.enum(["mayor", "polecat"]).optional().describe("Role to adopt the thread into; defaults to polecat."),
  beadId: z.string().trim().min(1).optional().describe("Ledger bead this thread owns; claimed if open."),
});

const adoptPrParams = z.object({
  gitUrl: z.string().trim().min(1).max(2_000).optional().describe("Repository URL; finds or creates the rig. Omit when rigProjectId is given."),
  rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project that owns the pull request."),
  prNumber: z.number().int().min(1),
});

const createRigParams = z.object({
  gitUrl: z.string().trim().min(1).max(2_000).describe("HTTPS or SSH URL of the repository to clone as a rig."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional()
    .describe("Rig name; defaults to the repository's name."),
});

const reviewSpecParams = {
  mode: z.enum(["lite", "full"]).optional().describe("lite: one reviewer covers all criteria. full: one reviewer per criterion (lens)."),
  persona: z.string().trim().max(500).optional().describe("Review persona, e.g. 'a seasoned, high-level Elixir/Phoenix software engineer'."),
  criteria: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe("What to assess; defaults to security, maintainability, performance, quality."),
};

const reviewParams = z.object({
  threadId: z.string(),
  focus: z.string().trim().max(4_000).optional().describe("What the review should concentrate on."),
  ...reviewSpecParams,
});

const prReviewParams = z.object({
  gitUrl: z.string().trim().min(1).max(2_000).optional().describe("Repository URL; finds or creates the rig. Omit when rigProjectId is given."),
  rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project that owns the pull request."),
  prNumber: z.number().int().min(1),
  ...reviewSpecParams,
  focus: z.string().trim().max(2_000).optional(),
});

const boardBeadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.union([z.number(), z.string()]).nullable(),
  labels: z.array(z.string()).nullable(),
  ready: z.boolean(),
  threadId: z.string().nullable(),
  threadState: z.string().nullable(),
}).strict();
export type BoardBead = z.infer<typeof boardBeadSchema>;

type BoardConvoy = { id: string; title: string; status: string; beads: BoardBead[] };

const townEventSchema = z.object({
  at: z.number(),
  kind: z.string(),
  message: z.string(),
  threadId: z.string().nullable(),
  beadId: z.string().nullable(),
}).strict();
export type TownEvent = z.infer<typeof townEventSchema>;

const statusOutputSchema = z.object({
  sectionId: z.string().nullable(),
  townProjectId: z.string().nullable(),
  mayor: managedThreadSchema.nullable(),
  threads: z.array(managedThreadSchema),
  rigs: z.array(rigSchema),
  ledger: z
    .object({
      bdAvailable: z.boolean(),
      initialized: z.boolean(),
      path: z.string().nullable(),
      open: z.number(),
      inProgress: z.number(),
      ready: z.number(),
      convoys: z.number(),
    })
    .nullable(),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusOutputSchema,
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  rigAdd: {
    input: z.object({
      projectId: z.string().trim().min(1),
      forge: z.enum(["gh", "glab", "gt", "tea", "none"]).nullable().optional(),
    }).strict(),
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
  browseTownDirectories: {
    input: z.object({ path: z.string().trim().min(1).optional() }).strict(),
    output: z
      .object({
        hostId: z.string(),
        directory: z.string(),
        parent: z.string().nullable(),
        roots: z.array(z.string()),
        directories: z.array(z.object({ name: z.string(), path: z.string() }).strict()),
      })
      .strict(),
  },
  ledgerInit: {
    input: z.object({}).strict(),
    output: z.object({ initialized: z.boolean(), path: z.string() }).strict(),
  },
  townHall: {
    input: z.null(),
    output: z.object({
      status: statusOutputSchema,
      convoys: z.array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            beads: z.array(boardBeadSchema),
          })
          .strict(),
      ),
      looseBeads: z.array(boardBeadSchema),
      events: z.array(townEventSchema),
    }),
  },
});

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  project_id: string;
  mayor_thread_id: string | null;
  worker_thread_id: string | null;
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
  review_requested_by: string | null;
  last_report_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RigRow {
  project_id: string;
  name: string;
  forge: string | null;
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
- Do not delete user threads. town_complete closes the bead and archives the thread (once no reviewer is still running); the owner can always unarchive.`;

/** Seeded into a brand-new town folder; never overwrites an existing file. */
const STARTER_TOWN_MD = `# Town rules

This file is the town's standing rules — every thread in this town reads it.
The Mayor maintains it: add durable preferences and policies here as they
come up (naming, review bar, commit style, release rituals, escalation
norms). Keep it short; it is read on every spawn.

- Keep thread titles literal and recognizable. Never invent codenames.
- Escalation flows polecat → Mayor → owner. Bring the owner only genuine
  product decisions, credentials, external accounts, and irreversible actions.
- Absolute law: never commit to or merge a repo's main/default branch without
  the owner's explicit say-so.
- Polecats work in their own worktrees; anything outside a worktree flows
  through the Mayor.

Town-local skills live in \`skills/<role>/<name>/SKILL.md\` — role being
\`mayor\`, \`polecat\`, \`reviewer\`, \`buzzard\`, \`imperator\`, or \`shared\`
(every role). SKILL.md carries \`name\` and \`description\` frontmatter. The
matching skills are injected into a thread's brief at launch; the Mayor
maintains these too.
`;

/** Absolute, ~-expanded — the plugin server may not share the caller's cwd. */
function normalizeTownPath(input: string) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

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
    reviewerProvider: { type: "string", label: "Reviewer provider", default: "" },
    reviewerModel: { type: "string", label: "Reviewer model", default: "" },
    reviewerReasoning: { type: "select", label: "Reviewer reasoning", options: [...reasoningOptions], default: "high" },
    buzzardProvider: { type: "string", label: "Buzzard provider", default: "" },
    buzzardModel: { type: "string", label: "Buzzard model", default: "" },
    buzzardReasoning: { type: "select", label: "Buzzard reasoning", options: [...reasoningOptions], default: "high" },
    imperatorProvider: { type: "string", label: "Imperator provider", default: "" },
    imperatorModel: { type: "string", label: "Imperator model", default: "" },
    imperatorReasoning: { type: "select", label: "Imperator reasoning", options: [...reasoningOptions], default: "high" },
    buzzardCron: { type: "string", label: "Buzzard sweep schedule (cron, empty = off; reload after change)", default: "" },
    imperatorCron: { type: "string", label: "Imperator security patrol schedule (cron, empty = off; reload after change)", default: "" },
    buzzardUnmaintained: { type: "boolean", label: "Buzzard also flags unmaintained dependencies", default: false },
    polecatPermissionMode: {
      type: "select",
      label: "Polecat permission mode",
      options: [...permissionModes],
      default: "accept-edits",
    },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "30" },
    mergeWatch: {
      type: "boolean",
      label: "Close out merged PRs automatically (bead closed, thread completed and archived once no reviewer is still running)",
      default: true,
    },
    rigsDir: {
      type: "string",
      label: "Rigs directory (empty = <town>/rigs)",
      default: "",
    },
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
    `CREATE TABLE IF NOT EXISTS town_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      thread_id TEXT,
      bead_id TEXT
    )`,
    `ALTER TABLE town_threads ADD COLUMN worker_thread_id TEXT`,
    `CREATE TABLE IF NOT EXISTS town_threads_v2 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('mayor','polecat','reviewer','buzzard','imperator')),
      project_id TEXT NOT NULL,
      mayor_thread_id TEXT,
      worker_thread_id TEXT,
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
    `INSERT INTO town_threads_v2 (thread_id, role, project_id, mayor_thread_id, worker_thread_id, bead_id, tier, title, state, status, result, blocker, recommendation, active_since, active_cycle, stall_alerted_cycle, created_at, updated_at)
      SELECT thread_id, role, project_id, mayor_thread_id, worker_thread_id, bead_id, tier, title, state, status, result, blocker, recommendation, active_since, active_cycle, stall_alerted_cycle, created_at, updated_at FROM town_threads`,
    `DROP TABLE town_threads`,
    `ALTER TABLE town_threads_v2 RENAME TO town_threads`,
    `CREATE INDEX IF NOT EXISTS town_threads_mayor ON town_threads (mayor_thread_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS town_threads_project ON town_threads (project_id, created_at)`,
    `ALTER TABLE town_threads ADD COLUMN review_requested_by TEXT`,
    `CREATE TABLE IF NOT EXISTS pr_watch (
      url TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      bead_id TEXT,
      number INTEGER NOT NULL,
      forge TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      failures INTEGER NOT NULL DEFAULT 0,
      last_checked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `ALTER TABLE rigs ADD COLUMN forge TEXT`,
    `ALTER TABLE town_threads ADD COLUMN last_report_at INTEGER`,
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

  /** The town's activity feed — one row per thing worth having seen. */
  function logEvent(kind: string, message: string, threadId?: string | null, beadId?: string | null) {
    db.prepare(`INSERT INTO town_events (at, kind, message, thread_id, bead_id) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), kind, clip(message, MAX_ALERT_LENGTH), threadId ?? null, beadId ?? null);
    publishTown();
  }

  function recentEvents(limit = 50): TownEvent[] {
    const rows = db.prepare(`SELECT at, kind, message, thread_id, bead_id FROM town_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as { at: number; kind: string; message: string; thread_id: string | null; bead_id: string | null }[];
    return rows.map((row) => ({
      at: row.at,
      kind: row.kind,
      message: row.message,
      threadId: row.thread_id,
      beadId: row.bead_id,
    }));
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
    reviewRequestedBy?: "mayor" | "polecat" | null;
  }) {
    const now = Date.now();
    db.prepare(`INSERT INTO town_threads (
      thread_id, role, project_id, mayor_thread_id, bead_id, tier, title,
      state, status, active_since, active_cycle, created_at, updated_at, review_requested_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      mayor_thread_id=excluded.mayor_thread_id, bead_id=excluded.bead_id, tier=excluded.tier,
      title=excluded.title, state=excluded.state, status=excluded.status, updated_at=excluded.updated_at,
      review_requested_by=excluded.review_requested_by`).run(
      input.threadId, input.role, input.projectId, input.mayorThreadId ?? null,
      input.beadId ?? null, input.tier ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.state === "active" ? now : null,
      input.state === "active" ? 1 : 0, now, now, input.reviewRequestedBy ?? null,
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
    // Always re-read: town.md is the owner's (and the Mayor's) live steering
    // file — edits must take effect without a plugin reload. The cache only
    // feeds the synchronous agent-configuration path.
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

  interface TownSkill {
    name: string;
    description: string;
    body: string;
    path: string;
  }

  /**
   * Town-local skills, scoped by role: <town>/skills/<role>/<name>/SKILL.md
   * (plus <town>/skills/shared/<name>/SKILL.md for every role). SKILL.md carries
   * name/description frontmatter, mirroring the common skill-file convention.
   */
  async function readTownSkills(townPath: string, roles: string[]): Promise<TownSkill[]> {
    const groups = [...new Set([...roles, "shared"])];
    const skills: TownSkill[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      const groupDir = join(townPath, "skills", group);
      let entries;
      try {
        entries = await readdir(groupDir, { withFileTypes: true });
      } catch {
        continue; // role has no skills directory — fine
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(`${group}/${entry.name}`)) continue;
        const skillFile = join(groupDir, entry.name, "SKILL.md");
        try {
          const raw = await readFile(skillFile, "utf8");
          const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
          const meta = front?.[1] ?? "";
          const field = (key: string) =>
            new RegExp(`^${key}:\\s*(.+)$`, "im").exec(meta)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
          const body = front ? raw.slice(front[0].length).trim() : raw.trim();
          skills.push({
            name: clip(field("name") || entry.name, 80),
            description: clip(field("description"), 240),
            body: clip(body, 6_000),
            path: skillFile,
          });
          seen.add(`${group}/${entry.name}`);
        } catch {
          // Ignore unreadable entries — a half-written skill must not break the spawn.
        }
      }
      if (skills.length >= 40) break;
    }
    return skills;
  }

  /** Render the town-skills prompt section; full content inlined up to a budget. */
  function renderTownSkills(skills: TownSkill[]): string[] {
    if (skills.length === 0) return [];
    const lines = [
      "",
      "## Town skills",
      "This town ships its own skills (from its skills/ folder). Apply the ones that fit the task; do not wait to be told.",
    ];
    let budget = 12_000;
    for (const skill of skills) {
      const block = `${lines.length === 3 ? "" : ""}\n### ${skill.name}${skill.description ? ` — ${skill.description}` : ""}\n${skill.body}\n`;
      if (block.length <= budget) {
        lines.push(block);
        budget -= block.length;
      } else {
        lines.push(`\n- ${skill.name} — ${skill.description} (read ${skill.path} when it applies)`);
      }
    }
    return lines;
  }

  /** Town skills available to a role, rendered for a spawn prompt (empty when none). */
  async function townSkillsSection(roles: string[], projectId?: string): Promise<string[]> {
    const townId = projectId ?? (await configuredTownProject());
    if (!townId) return [];
    const source = await townSource(townId);
    if (!source) return [];
    return renderTownSkills(await readTownSkills(source.path, roles));
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
    logEvent("town", `Town project set: ${projectId}`);
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

  // ── The Beads ledger ─────────────────────────────────────────────────
  // bd is the single source of truth for work items; plugin storage only
  // maps threads to beads. Every bd call is scoped with -C <town checkout>
  // so a polecat worktree can never discover the wrong ledger. Plugin bd
  // operations run as the ambient git identity on purpose: the owner's
  // manual bd commands must interoperate with the town's (claims, closes,
  // heartbeats all check the holder's identity).

  let bdAvailable: boolean | null = null;
  async function isBdAvailable() {
    if (bdAvailable === null) {
      bdAvailable = await execFileAsync("bd", ["--version"], { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
    }
    return bdAvailable;
  }

  /** The town's default local source: the checkout the ledger lives in. */
  async function townSource(projectIdOverride?: string): Promise<{ path: string; hostId: string } | null> {
    const townProjectId = projectIdOverride ?? (await configuredTownProject());
    if (!townProjectId) return null;
    try {
      const project = await bb.sdk.projects.get({ projectId: townProjectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source ? { path: source.path, hostId: source.hostId } : null;
    } catch {
      return null;
    }
  }

  /** Infer a rig's forge from its origin remote; null when unrecognizable. */
  async function inferForgeFromRemote(projectId: string): Promise<ForgeCli> {
    const path = await projectSourcePath(projectId);
    if (!path) return null;
    try {
      const remote = (await execFileAsync("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout.trim();
      const family = forgeFromRemote(remote);
      if (family === "github") return "gh";
      if (family === "gitlab") return "glab";
      if (family === "gitea") return detectGiteaCli();
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve the forge + CLI for a project (its rig, if registered): an explicit
   * rig pin wins, then a per-run inference from the rig's origin remote, else
   * nothing — never a guess. Only `gt` pins are verified at resolve time: `gt`
   * is ambiguous (Graphite uses the same binary name), so a gt pin only holds
   * when the binary proves it is gitea-cli. Explicit gh/glab/tea pins are taken
   * at face value — those binary names are unambiguous. */
  async function resolveForge(projectId: string): Promise<{ forge: Forge; cli: ForgeCli }> {
    const rig = rigById.get(projectId) as RigRow | undefined;
    const pinned = rig?.forge ?? null;
    const installed = async (bin: string) =>
      execFileAsync(bin, ["--version"], { timeout: 5_000 }).then(() => true, () => false);
    if (pinned === "none") return { forge: null, cli: null };
    if (pinned === "gh") return { forge: "github", cli: "gh" };
    if (pinned === "glab") return { forge: "gitlab", cli: "glab" };
    if (pinned === "tea") return { forge: "gitea", cli: "tea" };
    if (pinned === "gt") return { forge: "gitea", cli: (await detectGiteaCli()) === "gt" ? "gt" : null };
    const detected = await inferForgeFromRemote(projectId);
    if (detected === "gh") return { forge: "github", cli: (await installed("gh")) ? "gh" : null };
    if (detected === "glab") return { forge: "gitlab", cli: (await installed("glab")) ? "glab" : null };
    if (detected === "gt" || detected === "tea") return { forge: "gitea", cli: detected };
    return { forge: null, cli: null };
  }

  async function projectSourcePath(projectId: string): Promise<string | null> {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.path ?? null;
    } catch {
      return null;
    }
  }

  /** Forge lines for a brief: which CLI to use, or explicit degraded-mode instructions. */
  function forgeLines(forge: Forge, cli: ForgeCli): string[] {
    const expectedCli = forge === "github" ? "gh" : forge === "gitlab" ? "glab" : "gt";
    if (!cli) {
      if (forge === null) {
        return [
          "No forge CLI (gh/glab/gt/tea) is available on the BB host.",
          "Use plain git for everything. Do not run gh, glab, gt, or tea commands.",
          "Fetch the change with git fetch and inspect it with git log/diff. Do not post anything anywhere.",
        ];
      }
      const name = forge === "github" ? "GitHub" : forge === "gitlab" ? "GitLab" : "Gitea/Forgejo";
      return [
        `${name} was detected from the remote, but its CLI is not installed or not usable (expected: ${expectedCli}${forge === "gitea" ? " or tea" : ""}).`,
        "Use plain git for reading (git fetch, git log, git diff). Do not post anything anywhere.",
      ];
    }
    if (cli === "gh") {
      return [
        "Forge: GitHub — use the gh CLI (`gh pr --help`, `gh issue --help` for syntax).",
      ];
    }
    if (cli === "glab") {
      return [
        "Forge: GitLab — use the glab CLI. A pull request here is a merge request: glab mr view/create/checkout/diff (`glab mr --help`). Issues: glab issue view.",
      ];
    }
    if (cli === "gt") {
      return [
        "Forge: Gitea/Forgejo — use the gt CLI, the official Gitea CLI (`gt --help`; pull requests are `gt pr …`, e.g. gt pr view, gt pr checkout).",
      ];
    }
    return [
      "Forge: Gitea/Forgejo — use the tea CLI (legacy; succeeded by gt, the official gitea-cli). `tea --help`; pull requests are `tea pr …`.",
    ];
  }

  /** Concrete PR/MR review commands per forge. */
  function prCommands(forge: Forge, cli: ForgeCli, prNumber: number): string[] {
    if (cli === "gh") {
      return [
        `1. Run: gh pr view ${prNumber} --json title,body,additions,deletions,files,headRefName`,
        `2. Run: gh pr checkout ${prNumber}`,
        `3. Read the diff: gh pr diff ${prNumber}`,
      ];
    }
    if (cli === "glab") {
      return [
        `1. Run: glab mr view ${prNumber}`,
        `2. Run: glab mr checkout ${prNumber}`,
        `3. Read the diff: glab mr diff ${prNumber}`,
      ];
    }
    if (cli === "gt") {
      return [
        `1. Run: gt pr view ${prNumber}`,
        `2. Run: gt pr checkout ${prNumber}`,
        `3. Read the diff: gt pr diff ${prNumber}`,
      ];
    }
    if (cli === "tea") {
      return [
        `1. Run: tea pr view ${prNumber} (use --help for exact flags)`,
        `2. Check it out: tea pr checkout ${prNumber}`,
        `3. Read the diff: tea pr diff ${prNumber}`,
      ];
    }
    const ref = forge === "gitlab" ? `refs/merge-requests/${prNumber}/head` : `refs/pull/${prNumber}/head`;
    return [
      `1. Fetch the change: git fetch origin ${ref}`,
      `2. Create a local branch: git checkout -b review-pr-${prNumber} FETCH_HEAD`,
      "3. Read the diff with git diff against the default branch",
    ];
  }

  /** The town checkout path, from the town project's default local source. */
  async function townLedgerDir(): Promise<string> {
    const source = await townSource();
    if (source) return source.path;
    const townProjectId = await configuredTownProject();
    if (!townProjectId) throw new Error(await noTownMessage());
    throw new Error("The town project has no local source; the ledger needs a checkout on the bb server's machine.");
  }

  async function runBd(args: string[]): Promise<string> {
    const cwd = await townLedgerDir();
    try {
      const { stdout } = await execFileAsync("bd", ["-C", cwd, ...args], {
        timeout: BD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`bd ${args[0] ?? ""} failed in ${cwd}: ${clip(detail, 1_000)}`);
    }
  }

  async function bdJson<T>(args: string[]): Promise<T> {
    const stdout = await runBd([...args, "--json"]);
    const parsed: unknown = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown }).issues ?? parsed) as T;
  }

  async function ensureLedger(): Promise<void> {
    if (!(await isBdAvailable())) {
      throw new Error("bd (Beads) was not found on the bb server machine — install it: https://github.com/gastownhall/beads");
    }
    if (!existsSync(join(await townLedgerDir(), ".beads"))) {
      throw new Error("The town ledger is not initialized. Run: bb madmax ledger init");
    }
  }

  async function initLedgerAt(path: string) {
    await execFileAsync("bd", ["init"], { cwd: path, timeout: BD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    // The refinery lands beads in a review status; bd needs it registered.
    await execFileAsync("bd", ["config", "set", "status.custom", "review"], {
      cwd: path,
      timeout: BD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }).catch((error) => bb.log.warn(`status.custom review not set: ${String(error)}`));
    ledgerCache = null;
  }

  async function initLedger(): Promise<{ initialized: boolean; path: string }> {
    const path = await townLedgerDir();
    if (existsSync(join(path, ".beads"))) return { initialized: true, path };
    if (!(await isBdAvailable())) {
      throw new Error("bd (Beads) was not found on the bb server machine — install it: https://github.com/gastownhall/beads");
    }
    await initLedgerAt(path);
    logEvent("ledger", `Ledger initialized at ${path}`);
    return { initialized: true, path };
  }

  function invalidateLedger() {
    ledgerCache = null;
  }

  type LedgerBlock = {
    bdAvailable: boolean;
    initialized: boolean;
    path: string | null;
    open: number;
    inProgress: number;
    ready: number;
    convoys: number;
  };

  let ledgerCache: { at: number; value: LedgerBlock } | null = null;
  async function ledgerBlock(): Promise<LedgerBlock | null> {
    if (!(await configuredTownProject())) return null;
    if (ledgerCache && Date.now() - ledgerCache.at < LEDGER_CACHE_MS) return ledgerCache.value;
    const value: LedgerBlock = {
      bdAvailable: await isBdAvailable(),
      initialized: false,
      path: null,
      open: 0,
      inProgress: 0,
      ready: 0,
      convoys: 0,
    };
    if (value.bdAvailable) {
      try {
        const path = await townLedgerDir();
        value.path = path;
        if (existsSync(join(path, ".beads"))) {
          const [issues, readyIssues] = await Promise.all([
            bdJson<Bead[]>(["list", "--all"]),
            bdJson<Bead[]>(["ready"]),
          ]);
          value.initialized = true;
          value.open = issues.filter((issue) => issue.status === "open" && issue.issue_type !== "epic").length;
          value.inProgress = issues.filter((issue) => issue.status === "in_progress").length;
          value.ready = readyIssues.filter((issue) => issue.issue_type !== "epic").length;
          value.convoys = issues.filter((issue) => issue.issue_type === "epic" && issue.status !== "closed").length;
        }
      } catch {
        // A town without a resolvable checkout stays quiet here; operations
        // that need the ledger report their own errors.
      }
    }
    ledgerCache = { at: Date.now(), value };
    return value;
  }

  /** The convoy board: bd epics with their beads, linked to working threads. */
  async function ledgerBoard(): Promise<{ convoys: BoardConvoy[]; looseBeads: BoardBead[] }> {
    const empty: { convoys: BoardConvoy[]; looseBeads: BoardBead[] } = { convoys: [], looseBeads: [] };
    if (!(await configuredTownProject())) return empty;
    try {
      if (!(await isBdAvailable())) return empty;
      if (!existsSync(join(await townLedgerDir(), ".beads"))) return empty;
      const [issues, readyIssues] = await Promise.all([
        bdJson<Bead[]>(["list", "--all"]),
        bdJson<Bead[]>(["ready"]),
      ]);
      const readyIds = new Set(readyIssues.map((bead) => bead.id));
      const rowsByBead = new Map<string, ManagedRow>();
      for (const row of roles.values()) {
        if (row.bead_id) rowsByBead.set(row.bead_id, row);
      }
      const toBoardBead = (bead: Bead): BoardBead => {
        const row = rowsByBead.get(bead.id);
        return {
          id: bead.id,
          title: bead.title,
          status: bead.status,
          priority: bead.priority ?? null,
          labels: bead.labels ?? null,
          ready: readyIds.has(bead.id),
          threadId: row?.thread_id ?? null,
          threadState: row?.state ?? null,
        };
      };
      const priorityOf = (bead: BoardBead) => (typeof bead.priority === "number" ? bead.priority : 99);
      const epics = issues.filter((issue) => issue.issue_type === "epic" && issue.status !== "closed");
      const convoys = epics.map((epic) => ({
        id: epic.id,
        title: epic.title,
        status: epic.status,
        beads: issues
          .filter((issue) => issue.parent === epic.id && issue.issue_type !== "epic")
          .map(toBoardBead)
          .sort((a, b) => priorityOf(a) - priorityOf(b) || a.title.localeCompare(b.title)),
      }));
      const looseBeads = issues
        .filter((issue) => !issue.parent && issue.issue_type !== "epic" && issue.status !== "closed")
        .map(toBoardBead)
        .sort((a, b) => priorityOf(a) - priorityOf(b) || a.title.localeCompare(b.title));
      return { convoys, looseBeads };
    } catch {
      return empty;
    }
  }

  async function spawnMayor(target: string, previous?: ManagedRow) {
    const values = await settings.get();
    const sectionId = await ensureSection();
    const name = await projectName(target);
    const rules = await readRules(target);
    const title = `Mayor · ${name}`;
    const source = await townSource(target);
    const townPath = source?.path ?? null;
    const mayorSkillLines = await townSkillsSection(["mayor"], target);
    const prompt = [
      `You are the Mayor of ${name} — the town's chief-of-staff agent. You coordinate work across the town's registered rig projects through visible polecat threads.`,
      "",
      "You run directly in the town checkout, not a worktree. The owner sees the same files you do. bd run from your shell reads the town ledger.",
      "",
      townPath
        ? `This town lives at ${townPath}. It holds the bead ledger (.beads/), town.md (the town's standing rules), and the rigs/ checkouts — the owner sees the same files, so make surgical changes and commit them like normal files.`
        : "The town checkout path is unknown to this spawn; ask the owner where the town folder lives.",
      "town.md in the town root is this town's living rules file — every thread in the town reads it. When the owner gives a standing preference or policy (naming, review bar, commit style, release ritual, escalation norms), record it in town.md yourself. For a repeatable capability, add a town-local skill at skills/<role>/<name>/SKILL.md (frontmatter: name, description; role is mayor, polecat, reviewer, buzzard, imperator, or shared for everyone) and point at it from town.md. Keep both short; agents read them at launch.",
      ...mayorSkillLines,
      "",
      "Use town_sling to start one polecat per self-contained work item; choose the model tier honestly (simplest for trivial mechanical work, small for lookups and single-file changes, medium for multi-file features, difficult for tricky logic, mostDifficult for adversarial or security-sensitive work).",
      "When the owner names a repository the town doesn't know, create the rig yourself with town_create_rig (give it the git URL). The town works with GitHub, GitLab, and Gitea/Forgejo: a rig's forge is inferred from its remote URL (github.com, gitlab.com, codeberg.org, forgejo/gitea hosts). If the host does not identify the forge — for example a homelab server such as https://git.home — do not guess: ask the owner which forge it is and record the answer with town_set_rig_forge. Do the same whenever a forge command fails with a CLI error that looks like a mis-detection.",
      "Use town_roster for the town's threads. Before deciding, use town_inspect to read a thread's live status, persisted report, and last assistant output. Reports are evidence, not proof — verify with town_verify.",
      "Use town_nudge to answer a polecat's question or correct course; steer only a thread working something wrong right now.",
      "Polecats report ready or blocked; only you decide when work is verified. Polecats request their own adversarial review in their worktree and fix the findings before reporting ready — review is part of their loop, not a gate you run. town_review stays yours for owner-commissioned deep dives (a persona and criteria you name); if a fresh verdict on the current work exists it is returned instead of spawning a duplicate — pass force: true only when you genuinely want independent eyes. Verify with town_verify before landing, land verified work with town_land (branch pushed, bead to review), and mark it complete with town_complete (it closes the bead and archives the thread once no reviewer is still running). The town watches pull requests your polecats open: when one merges, the bead closes and the thread is completed and archived automatically — no action needed from you. To review someone else's pull request, use town_pr_review — it mints the bead and the reviewer threads; you compile findings and draft the PR response, and the owner decides posting. Escalate to the owner only genuine product decisions, credentials, external accounts, and irreversible actions — lead with a recommendation and the evidence.",
      "",
      "You are the owner's main interface, so this thread stays responsive. Never run long-blocking commands here — no watching CI (gh run watch), no long builds, no long test suites, no waiting on anything slow. Hand long waits to a polecat as a brief and end your turn; its report wakes you.",
      "", "## Town rules", rules,
      "", "Acknowledge the rules briefly, inspect the roster, and wait for work.",
    ].join("\n");
    // The Mayor runs directly in the town checkout — never a worktree — so
    // the owner and the Mayor see the same files and `bd` finds the town
    // ledger from the Mayor's shell, whatever the owner's default
    // new-thread environment is.
    if (!source) {
      bb.log.warn("Town project has no local source; the Mayor runs on the project's default environment instead of the town checkout.");
    }
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: source
        ? { type: "host", hostId: source.hostId, workspace: { type: "unmanaged", path: source.path } }
        : { type: "project-default" },
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
    logEvent("mayor", `Mayor started: ${title}`, thread.id);
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

  /** First-run flow: create the town folder on disk, register it, start it. */
  async function createTown(input: { name: string; path: string; hostId?: string }) {
    const hostId = input.hostId ?? (await defaultHostId());
    const path = normalizeTownPath(input.path);
    // Bootstrap the folder first — bb registers local paths without checking
    // they exist, and a town pointing at nothing strands its Mayor.
    try {
      await bb.sdk.files.mkdir({ hostId, path, recursive: true });
    } catch (error) {
      try {
        await bb.sdk.files.list({ hostId, path, limit: 1 });
      } catch {
        throw error; // the folder truly cannot be created or reached
      }
    }
    let hasRules = true;
    try {
      await bb.sdk.files.read({ hostId, path: `${path}/town.md` });
    } catch {
      hasRules = false;
    }
    if (!hasRules) {
      await bb.sdk.files.write({
        hostId,
        path: `${path}/town.md`,
        content: STARTER_TOWN_MD,
        contentEncoding: "utf8",
      });
      try {
        if (!existsSync(join(path, "skills"))) {
          await mkdir(join(path, "skills"), { recursive: true });
          await writeFile(
            join(path, "skills", "README.md"),
            [
              "# Town skills",
              "",
              "One directory per skill, grouped by role:",
              "",
              "    skills/mayor/<name>/SKILL.md      # Mayor only",
              "    skills/polecat/<name>/SKILL.md    # polecats only",
              "    skills/reviewer/<name>/SKILL.md   # reviewers only",
              "    skills/buzzard/<name>/SKILL.md    # Buzzard patrols only",
              "    skills/imperator/<name>/SKILL.md  # Imperator patrols only",
              "    skills/shared/<name>/SKILL.md     # every role",
              "",
              "Each SKILL.md carries `name:` and `description:` frontmatter.",
              "Matching skills are injected into a thread's brief at launch;",
              "the Mayor maintains these files. Keep them short.",
              "",
            ].join("\n"),
            "utf8",
          );
        }
      } catch (error) {
        bb.log.warn(`Town skills directory could not be seeded: ${String(error)}`);
      }
    }
    // A town wants version control and a ledger. Both are best-effort:
    // a town without git or bd still works for brief-only slings, and the
    // UI surfaces what is missing.
    try {
      if (!existsSync(join(path, ".git"))) {
        await execFileAsync("git", ["init"], { cwd: path, timeout: 30_000 });
      }
    } catch (error) {
      bb.log.warn(`git init skipped for the new town: ${String(error)}`);
    }
    try {
      if (!existsSync(join(path, ".beads")) && (await isBdAvailable())) {
        await initLedgerAt(path);
      }
    } catch (error) {
      bb.log.warn(`bd init skipped for the new town: ${String(error)}`);
    }
    const project = await bb.sdk.projects.create({
      name: input.name,
      source: { type: "local_path", hostId, path },
    });
    logEvent("town", `Town folder created: ${input.name} at ${path}`);
    const start = await chooseTown(project.id);
    return { projectId: project.id, threadId: start.threadId, created: start.created };
  }

  function isRig(projectId: string) {
    return rigById.get(projectId) !== undefined;
  }

  async function addRig(projectId: string, forge?: string | null): Promise<Rig> {
    const existing = rigById.get(projectId) as RigRow | undefined;
    if (existing) {
      if (forge !== undefined && forge !== existing.forge) {
        db.prepare(`UPDATE rigs SET forge=? WHERE project_id=?`).run(forge, projectId);
        publishTown();
        return { projectId: existing.project_id, name: existing.name, forge, registeredAt: existing.registered_at };
      }
      return { projectId: existing.project_id, name: existing.name, forge: existing.forge ?? null, registeredAt: existing.registered_at };
    }
    const name = await projectName(projectId);
    const resolvedForge = forge !== undefined ? forge : await inferForgeFromRemote(projectId);
    const now = Date.now();
    db.prepare(`INSERT INTO rigs (project_id, name, forge, registered_at) VALUES (?, ?, ?, ?)`).run(projectId, name, resolvedForge ?? null, now);
    logEvent("rig", `Rig registered: ${name} (${projectId})${resolvedForge ? ` · forge ${resolvedForge}` : ""}`);
    publishTown();
    return { projectId, name, forge: resolvedForge ?? null, registeredAt: now };
  }

  function removeRig(projectId: string) {
    const result = db.prepare(`DELETE FROM rigs WHERE project_id=?`).run(projectId);
    if (result.changes > 0) logEvent("rig", `Rig removed: ${projectId}`);
    publishTown();
    return result.changes > 0;
  }

  /** Derive a rig name from a git URL: last path segment, minus .git. */
  function rigNameFromUrl(gitUrl: string): string {
    const base = gitUrl.replace(/\/+$/, "").split(/[/]/).pop() ?? "";
    const name = base.replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`Cannot derive a rig name from “${clip(gitUrl, 200)}”; pass a name explicitly.`);
    }
    return name;
  }

  /** Conversational rig onboarding: clone a repo, register it as a rig. */
  async function createRig(params: z.infer<typeof createRigParams>) {
    const name = params.name ?? rigNameFromUrl(params.gitUrl);
    const values = await settings.get();
    const hostId = await defaultHostId();
    const configuredDir = ((values.rigsDir as string | undefined) ?? "").trim();
    const baseDir = configuredDir !== "" ? normalizeTownPath(configuredDir) : join(await townLedgerDir(), "rigs");
    const target = join(baseDir, name);
    if (existsSync(target)) {
      throw new Error(
        `A folder for rig “${name}” already exists at ${target}. If it is already a bb project, register it with: bb madmax rig add <project-id>`,
      );
    }
    await mkdir(baseDir, { recursive: true });
    await execFileAsync("git", ["clone", params.gitUrl, target], {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    // Town-relative rigs stay out of the town repo's status quietly, without
    // touching the repo's tracked .gitignore (bd --stealth does the same).
    if (configuredDir === "") {
      try {
        const excludePath = join(await townLedgerDir(), ".git", "info", "exclude");
        if (existsSync(excludePath)) {
          const current = await readFile(excludePath, "utf8");
          if (!current.split("\n").includes("rigs/")) {
            await appendFile(excludePath, `${current.endsWith("\n") ? "" : "\n"}rigs/\n`);
          }
        }
      } catch (error) {
        bb.log.warn(`Could not update .git/info/exclude for rigs/: ${String(error)}`);
      }
    }
    const project = await bb.sdk.projects.create({
      name,
      source: { type: "local_path", hostId, path: target },
    });
    await addRig(project.id);
    logEvent("rig", `Rig cloned: ${name} from ${clip(params.gitUrl, 200)} (${project.id})`);
    return { projectId: project.id, name, path: target };
  }

  function rigProjectForLabel(label: string | undefined): string | null {
    if (!label) return null;
    const row = (allRigs.all() as RigRow[]).find(
      (candidate) => candidate.name === label || candidate.project_id === label,
    );
    return row?.project_id ?? null;
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

    // A bead carries its own brief; otherwise the caller must supply one.
    let bead: Bead | null = null;
    if (params.beadId) {
      await ensureLedger();
      const found = await bdJson<Bead[]>(["show", params.beadId]);
      bead = found[0] ?? null;
      if (!bead) throw new Error(`No bead ${params.beadId} in the town ledger.`);
      if (bead.status === "closed") throw new Error(`Bead ${params.beadId} is closed; reopen it before slinging.`);
    } else if (!params.title || !params.mission) {
      throw new Error("Sling needs either a beadId from the ledger, or both a title and a mission.");
    }
    const title = clip(params.title ?? bead!.title, 160);
    const mission = params.mission ?? bead!.description ?? bead!.title;

    const rigProjectId =
      params.rigProjectId ??
      (bead ? (bead.labels ?? []).map((label) => rigProjectForLabel(label)).find((id): id is string => id !== null) : undefined) ??
      townId;
    if (rigProjectId !== townId && !isRig(rigProjectId)) {
      throw new Error(`Project ${rigProjectId} is not a registered rig. Register it first: bb madmax rig add ${rigProjectId}`);
    }
    // Every unit of work belongs in the ledger: a direct sling files its own bead.
    // Without it the pipeline, the stats, and close-out all go blind to the work.
    if (!bead) {
      try {
        await ensureLedger();
        const description = [
          mission,
          ...(params.successCriteria?.length ? ["", "Success criteria:", ...params.successCriteria.map((item) => `- ${item}`)] : []),
          ...(params.constraints?.length ? ["", "Constraints:", ...params.constraints.map((item) => `- ${item}`)] : []),
          ...(params.context ? ["", params.context] : []),
        ].join("\n");
        const rigRow = (allRigs.all() as RigRow[]).find((row) => row.project_id === rigProjectId);
        const args = ["create", clip(title, 200), "-d", clip(description, 4_000), "--silent"];
        if (rigRow) args.push("-l", rigRow.name);
        const created = (await runBd(args)).trim();
        const found = await bdJson<Bead[]>(["show", created]);
        bead = found[0] ?? null;
        if (bead) invalidateLedger();
      } catch (error) {
        // Town without a working ledger: sling anyway, but say so loudly.
        bb.log.warn(`Slung “${title}” without a ledger bead (bd unavailable?): ${String(error)}`);
      }
    }
    if (bead) {
      await runBd(["update", bead.id, "--claim"]);
      invalidateLedger();
    }
    const tier: Tier = params.tier ?? DEFAULT_TIER;
    const forge = params.openPr ? await resolveForge(rigProjectId) : null;
    const sectionId = await ensureSection();
    const townName = await projectName(townId);
    const rigName = rigProjectId === townId ? `${townName} (town work)` : await projectName(rigProjectId);
    const permissionMode = ((values.polecatPermissionMode as SpawnPermissionMode) || "accept-edits");
    const brief = [
      `You are a polecat. You work for the town of ${townName}. Your work area is rig ${rigName}.`,
      "",
      "## Task",
      title,
      "",
      "## Goal",
      mission,
      "",
      "## Success criteria",
      bullets(params.successCriteria),
      "",
      "## Constraints",
      bullets(params.constraints),
      ...(params.context ? ["", "## Context", params.context] : []),
      ...(await townSkillsSection(["polecat"], townId)),
      ...(params.openPr && forge
        ? [
            "",
            "## Pull request",
            "- The owner approved opening a pull request for this task.",
            ...(forge.cli === "gh"
              ? [
                  "- When your changes are done: commit your work on your branch, push the branch (git push -u origin HEAD), then create the pull request: gh pr create.",
                ]
              : forge.cli === "glab"
                ? [
                    "- When your changes are done: commit your work on your branch, push the branch (git push -u origin HEAD), then create the merge request: glab mr create.",
                  ]
                : forge.cli === "gt"
                  ? [
                      "- When your changes are done: commit your work on your branch, push the branch (git push -u origin HEAD), then create the pull request: gt pr create.",
                    ]
                  : forge.cli === "tea"
                  ? [
                      "- When your changes are done: commit your work on your branch, push the branch (git push -u origin HEAD), then create the pull request: tea pr create (see tea --help for the exact flags).",
                    ]
                  : [
                      "- No forge CLI (gh/glab/gt/tea) is available. Push your branch (git push -u origin HEAD) and report the branch name; the owner will open the request manually.",
                    ]),
            "- Write the pull/merge request title and description in plain engineering language. No internal vocabulary.",
            "- Put the pull/merge request URL in your final report.",
          ]
        : []),
      "",
      "## Rules",
      "- Do only this task.",
      "- Work only in your worktree. Do not touch other projects or other worktrees.",
      "- Do not commit to or merge the main branch of any repository.",
      "- Do not push, merge, or delete anything, unless this task says so.",
      "- Do not post comments or reviews to external services.",
      "- Do not open a pull request, unless this task says the owner approved it.",
      "- Commit messages, pull request text, and comments read like a normal engineer wrote them. Do not mention the town, the Mayor, polecats, beads, or internal ids — unless this task says the vocabulary fits this repository.",
      "- Anything outside your worktree goes to the Mayor. Report it. Do not do it.",
      "- Check your work yourself. Run the closest real check. A typecheck alone is not enough.",
      "",
      "## Review",
      "- When your work is done and checked, request an adversarial review of your own work with polecat_request_review (lite unless told otherwise).",
      "- The reviewer works in your worktree. Their findings arrive in this thread. Fix what they find, commit, and request a fresh review.",
      "- Repeat until a verdict is ship. Do not report ready while a review finding is unaddressed.",
      "- If the reviewer and you disagree, report the disagreement to the Mayor instead of looping forever — state both sides and let the Mayor decide.",
      "",
      "## Report",
      "- Use polecat_report. Use state ready when the work is done. Use state blocked when you cannot continue.",
      "- A ready report states: what you changed, which files, which checks you ran, what remains — and the review verdict.",
      "- A blocked report states: the blocker, and your recommended next step.",
      "- You talk to the Mayor. Do not talk to the owner.",
      "- Run the task without waiting for more instructions.",
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
      title,
      permissionMode,
      parentThreadId: mayor.thread_id,
      lifecycleOwnerThreadId: mayor.thread_id,
      parentNotifications: "stuck",
      pluginMetadata: { role: "polecat", tier, rig: rigProjectId, town: townId, beadId: bead?.id ?? null },
      ...tierExecution(values, tier),
      prompt: brief,
    });
    insertThread({
      threadId: thread.id, role: "polecat", projectId: rigProjectId,
      mayorThreadId: mayor.thread_id, beadId: bead?.id ?? null, tier, title,
      state: "starting", status: thread.status,
    });
    logEvent(
      "sling",
      `Slung “${title}” to a polecat (tier ${tier}${bead ? `, bead ${bead.id}` : ""})`,
      thread.id,
      bead?.id ?? null,
    );
    return { threadId: thread.id, title, projectId: rigProjectId, tier, beadId: bead?.id ?? null };
  }

  async function nudge(threadId: string, text: string, steer = false, authorizeEdits = false) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error(`No managed polecat or reviewer ${threadId}.`);
    const payload =
      row.role === "reviewer"
        ? authorizeEdits
          ? `The Mayor explicitly authorizes a repair pass for this instruction: edits are allowed.\n\n${text}`
          : `Remain review-only: do not modify files.\n\n${text}`
        : text;
    await bb.sdk.threads.send({
      threadId,
      mode: steer ? "steer-if-active" : "queue-if-active",
      input: [{ type: "text", text: clip(payload, MAX_RESULT_LENGTH), mentions: [] }],
      senderThreadId: row.mayor_thread_id ?? undefined,
    });
    logEvent("nudge", `Nudged “${row.title}”${steer ? " (steering the running turn)" : ""}${authorizeEdits ? " (repair authorized)" : ""}`, threadId);
    db.prepare(`UPDATE town_threads SET state='active', blocker=NULL, recommendation=NULL,
      active_since=?, active_cycle=active_cycle+1, stall_alerted_cycle=NULL, updated_at=? WHERE thread_id=?`).run(
      Date.now(), Date.now(), threadId,
    );
    reloadRoles();
    publishTown();
    return roles.get(threadId)!;
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string, targetOverride?: string) {
    const target = targetOverride ?? (row.role === "mayor" ? row.thread_id : row.mayor_thread_id);
    if (!target) throw new Error(`Managed thread ${row.thread_id} has no recipient for its notification.`);
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

  async function alertMayor(row: ManagedRow, key: string, message: string, targetOverride?: string) {
    const outboxKey = enqueueAlert(row, key, message, targetOverride);
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
    db.prepare(`UPDATE town_threads SET state=?, result=?, blocker=?, recommendation=?, active_since=NULL, updated_at=?, last_report_at=? WHERE thread_id=?`).run(
      params.state, params.result ?? null, params.state === "blocked" ? params.blocker : null,
      params.recommendation ?? null, now, now, threadId,
    );
    reloadRoles();
    publishTown();
    const current = roles.get(threadId)!;
    // A review commissioned by a polecat reports to that polecat, not the Mayor.
    const reviewToWorker =
      row.role === "reviewer" && row.review_requested_by === "polecat" && row.worker_thread_id;
    const summary = reviewToWorker
      ? [
          `Reviewer report (${row.title})`,
          `State: ${params.state}`,
          ...(params.result ? [`Findings:\n${params.result}`] : []),
          ...(params.state === "blocked" && params.blocker ? [`Blocker: ${params.blocker}`] : []),
          ...(params.recommendation ? [`Verdict: ${params.recommendation}`] : []),
          "Address the findings (fix, commit), then request a fresh review with polecat_request_review. When a verdict is ship, call polecat_report with state ready and include the verdict.",
        ].join("\n")
      : [
          `${row.role === "reviewer" ? "Reviewer" : "Polecat"} report from ${row.title} (${threadId})`,
          `State: ${params.state}`,
          ...(params.result ? [`Result: ${params.result}`] : []),
          ...(params.state === "blocked" ? [`Blocker: ${params.blocker}`] : []),
          ...(params.recommendation ? [`Recommendation: ${params.recommendation}`] : []),
          "Inspect live evidence with town_inspect and choose: nudge, verify, complete, or escalate to the owner.",
        ].join("\n");
    const delivered = await alertMayor(
      current,
      `report:${now}:${randomUUID()}`,
      summary,
      reviewToWorker ? row.worker_thread_id! : undefined,
    );
    if (!delivered) {
      throw new Error(reviewToWorker
        ? "Report was saved but could not be delivered to the requesting polecat. It will retry automatically."
        : "Report was saved but could not be delivered to the Mayor. It will retry automatically; check Mayor connectivity before reporting again.");
    }
    logEvent(
      "report",
      `${row.role === "reviewer" ? "Reviewer" : "Polecat"} report from “${row.title}”: ${params.state}`,
      threadId,
      current.bead_id,
    );
    // Track any PRs the report mentions so a merge can be detected and close things out.
    try {
      const haystack = [params.result, params.recommendation, params.blocker].filter(Boolean).join("\n");
      for (const pr of parsePrUrls(haystack)) {
        // gitea-family: which binary (gt vs tea) is only known at poll time.
        const cli = pr.forge === "github" ? "gh" : pr.forge === "gitlab" ? "glab" : null;
        db.prepare(`INSERT OR IGNORE INTO pr_watch (url, thread_id, bead_id, number, forge, state, created_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?)`)
          .run(pr.url, row.thread_id, current.bead_id, pr.number, cli, Date.now());
      }
    } catch (error) {
      bb.log.warn(`Could not record PR watch entries for ${threadId}: ${String(error)}`);
    }
    // NDI: the ledger is the durable record — reports land on the bead.
    if (current.bead_id) {
      try {
        await runBd(["comment", current.bead_id, clip(summary, 4_000)]);
        invalidateLedger();
      } catch (error) {
        bb.log.warn(`Could not record the report on bead ${current.bead_id}: ${String(error)}`);
      }
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

  /** Mayor-verified completion; closes the linked bead in the ledger. */
  async function complete(threadId: string, result?: string, options: { archive?: boolean } = {}) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error(`No managed polecat or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    const now = Date.now();
    db.prepare(`UPDATE town_threads SET state='complete', status=?, result=COALESCE(?, result),
      blocker=NULL, recommendation=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      live.status, result ? clip(result, MAX_RESULT_LENGTH) : null, now, threadId,
    );
    reloadRoles();
    publishTown();
    const current = roles.get(threadId)!;
    let note = "";
    logEvent("complete", `Marked “${current.title}” complete`, threadId, current.bead_id);
    if (current.bead_id) {
      const summary = clip(result ?? current.result ?? "Verified complete by the Mayor.", 500);
      try {
        await runBd(["comment", current.bead_id, `Completed by the town: ${result ?? "verified by the Mayor."}`]);
        await runBd(["close", current.bead_id, "--reason", summary]);
        invalidateLedger();
        note = ` Bead ${current.bead_id} closed in the ledger.`;
      } catch (error) {
        note = ` WARNING: the thread is complete but bead ${current.bead_id} could not be closed: ${clip(String(error), 300)}`;
        bb.log.warn(note);
      }
    }
    if (options.archive !== false) {
      const pending = db.prepare(`SELECT COUNT(*) AS n FROM town_threads WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted','ready','blocked')`).get(threadId) as { n: number };
      if (pending.n > 0) {
        note += ` Thread left open: ${pending.n} reviewer(s) still running against it.`;
      } else {
        try {
          await bb.sdk.threads.archive({ threadId });
          note += " Thread archived.";
        } catch (error) {
          note += ` Thread could not be archived (${clip(String(error), 150)}); archive it from the thread menu.`;
          bb.log.warn(`Could not archive ${threadId}: ${String(error)}`);
        }
      }
    }
    return { threadId, title: current.title, beadId: current.bead_id, note };
  }

  interface PrWatchRow {
    url: string;
    thread_id: string;
    bead_id: string | null;
    number: number;
    forge: string | null;
    state: string;
    failures: number;
    last_checked: number;
    created_at: number;
  }

  async function queryPrState(forge: string, row: { number: number; url: string }, cwd: string | undefined): Promise<"merged" | "closed" | "open" | null> {
    const cwdOpt = cwd ? { cwd } : {};
    let args: { bin: string; args: string[] };
    if (forge === "gh" || forge === "gt") {
      // gh and gt both accept the full PR URL and gh-style --json/--jq, so no repo checkout is needed.
      args = forge === "gh"
        ? { bin: "gh", args: ["pr", "view", row.url, "--json", "state", "--jq", ".state"] }
        : { bin: "gt", args: ["pr", "view", row.url, "--json", "state", "--jq", ".state"] };
    } else if (forge === "glab") {
      // glab needs repo context; only callable with a worktree path.
      if (!cwd) return null;
      args = { bin: "glab", args: ["mr", "view", String(row.number), "--output", "json"] };
    } else {
      if (!cwd) return null;
      args = { bin: "tea", args: ["pr", "view", String(row.number), "--output", "json"] };
    }
    // gh prints MERGED/CLOSED/OPEN; gt a lowercase state; glab/tea print JSON like {"state":"merged"}.
    const { stdout } = await execFileAsync(args.bin, args.args, { ...cwdOpt, timeout: 15_000 });
    return parseForgePrState(stdout);
  }

  let lastPrWatchAt = 0;

  /** Detect merged/closed PRs for tracked threads and close them out. */
  async function pollPrWatch() {
    const settingsNow = await settings.get();
    if (settingsNow.mergeWatch === false) return;
    const now = Date.now();
    if (now - lastPrWatchAt < 5 * 60_000) return;
    lastPrWatchAt = now;
    const rows = db.prepare(
      `SELECT * FROM pr_watch WHERE state = 'open' AND last_checked < ? ORDER BY last_checked ASC LIMIT 10`,
    ).all(now - 60_000) as PrWatchRow[];
    for (const row of rows) {
      try {
        let forge = row.forge;
        const threadRow = roles.get(row.thread_id);
        if (!forge && threadRow) {
          const pin = (rigById.get(threadRow.project_id) as RigRow | undefined)?.forge;
          forge = (pin === "gh" || pin === "glab" || pin === "gt" || pin === "tea") ? pin : await inferForgeFromRemote(threadRow.project_id);
        }
        if (!forge) {
          // Forge unknown for this rig (unpinned, unrecognized remote) — try again later.
          db.prepare(`UPDATE pr_watch SET last_checked=? WHERE url=?`).run(now, row.url);
          continue;
        }
        // The worktree may be gone (archived thread); gh can still answer from the URL alone.
        let cwd: string | undefined;
        try {
          ({ path: cwd } = await threadWorktree(row.thread_id));
        } catch {
          cwd = undefined;
        }
        if (!cwd && forge !== "gh" && forge !== "gt") {
          db.prepare(`UPDATE pr_watch SET last_checked=? WHERE url=?`).run(now, row.url);
          continue;
        }
        const state = await queryPrState(forge, row, cwd);
        if (state === "merged") {
          // Close out quietly if the thread was already completed/archived by hand.
          const alreadyClosed = !threadRow || ["complete", "archived", "deleted"].includes(threadRow.state);
          let closeOutNote = "";
          if (threadRow && !alreadyClosed) {
            const result = await complete(row.thread_id, `Pull request merged: ${row.url}`);
            closeOutNote = result.note.trim();
          }
          db.prepare(`UPDATE pr_watch SET state='merged', forge=COALESCE(forge, ?), last_checked=? WHERE url=?`)
            .run(forge, now, row.url);
          logEvent("pr-watch", `PR merged: ${row.url}`, row.thread_id, row.bead_id);
          if (threadRow) {
            await alertMayor(threadRow, `pr-merged:${row.url}`, [
              `${row.url} merged.`,
              alreadyClosed
                ? "The work was already closed out — nothing left to do."
                : `Bead ${row.bead_id ?? "(none)"} closed in the ledger.${closeOutNote ? ` ${closeOutNote}` : ""}`,
            ].join("\n")).catch((error) => bb.log.warn(`Could not notify Mayor about ${row.url}: ${String(error)}`));
          }
          continue;
        }
        if (state === "closed") {
          db.prepare(`UPDATE pr_watch SET state='closed', forge=COALESCE(forge, ?), last_checked=? WHERE url=?`)
            .run(forge, now, row.url);
          logEvent("pr-watch", `PR closed without merging: ${row.url}`, row.thread_id, row.bead_id);
          if (threadRow) {
            await alertMayor(threadRow, `pr-closed:${row.url}`,
              `${row.url} was closed without merging. Bead ${row.bead_id ?? "(none)"} stays open — reopen the PR, rework it, or close the bead deliberately.`,
            ).catch((error) => bb.log.warn(`Could not notify Mayor about ${row.url}: ${String(error)}`));
          }
          continue;
        }
        if (state === "open") {
          db.prepare(`UPDATE pr_watch SET failures=0, last_checked=?, forge=COALESCE(forge, ?) WHERE url=?`).run(now, forge, row.url);
          continue;
        }
        // Unparseable answer — bounded tolerance, then stop and say so.
        const failures = row.failures + 1;
        if (failures >= 8) {
          db.prepare(`UPDATE pr_watch SET state='error', failures=?, last_checked=? WHERE url=?`).run(failures, now, row.url);
          if (threadRow) {
            await alertMayor(threadRow, `pr-watch-error:${row.url}`,
              `I could not determine the state of ${row.url} after ${failures} checks (forge CLI answered but the output did not parse). Giving up on watching it — please look manually.`,
            ).catch(() => undefined);
          }
        } else {
          db.prepare(`UPDATE pr_watch SET failures=?, last_checked=? WHERE url=?`).run(failures, now, row.url);
        }
      } catch (error) {
        const failures = row.failures + 1;
        const terminal = failures >= 8;
        db.prepare(`UPDATE pr_watch SET failures=?, last_checked=?, state=? WHERE url=?`)
          .run(failures, now, terminal ? "error" : "open", row.url);
        bb.log.warn(`PR watch failed for ${row.url}: ${String(error)}`);
        if (terminal) {
          const threadRow = roles.get(row.thread_id);
          if (threadRow) {
            await alertMayor(threadRow, `pr-watch-error:${row.url}`,
              `Watching ${row.url} failed ${failures} times (last error: ${clip(String(error), 200)}). Stopping; please check the PR manually.`,
            ).catch(() => undefined);
          }
        }
      }
    }
  }

  // ── The refinery: verify, review, land ──────────────────────────────
  // The Mayor is the refinery: it gathers deterministic evidence from the
  // worktree, can commission an independent read-only review, and delivers
  // finished work — branch pushed, bead to review — while the owner alone
  // decides the merge path.

  async function runGit(worktree: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", worktree, ...args], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(" ")} failed in ${worktree}: ${clip(detail, 1_000)}`);
    }
  }

  async function threadWorktree(threadId: string): Promise<{ path: string; branchName: string | null }> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      throw new Error(`${threadId} is not a live thread.`);
    }
    if (!thread.environmentId) {
      throw new Error(`${threadId} has no reusable environment (no worktree).`);
    }
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path) {
      throw new Error(`The environment for ${threadId} has no local path; the refinery needs the worktree on the bb server's machine.`);
    }
    return { path: environment.path, branchName: environment.branchName };
  }

  /** Deterministic evidence: git status, diff stat, and recent log. */
  async function verify(threadId: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error(`No managed polecat or reviewer ${threadId}.`);
    const { path, branchName } = await threadWorktree(threadId);
    const attempt = async (args: string[]) => runGit(path, args).catch((error) => `(${clip(String(error), 400)})`);
    const [status, diff, log] = await Promise.all([
      attempt(["status", "--porcelain=v1", "-b"]),
      attempt(["diff", "--stat", "HEAD"]),
      attempt(["log", "--oneline", "-8"]),
    ]);
    logEvent("verify", `Gathered worktree evidence for “${row.title}”`, threadId, row.bead_id);
    return [
      `Worktree: ${path}`,
      `Branch: ${branchName ?? "(detached)"}`,
      "",
      "## Status",
      status.trim() === "" ? "(clean)" : status,
      "",
      "## Diff against HEAD",
      diff.trim() === "" ? "(no unstaged changes)" : diff,
      "",
      "## Recent log",
      log.trim() === "" ? "(no commits yet)" : log,
    ].join("\n");
  }

  /** Deliver: commit uncommitted polecat work, push the branch, bead to review. */
  async function land(threadId: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "mayor") throw new Error(`No managed polecat or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot land ${threadId} while it is ${live.status}.`);
    const { path, branchName } = await threadWorktree(threadId);
    const changes = await runGit(path, ["status", "--porcelain=v1"]);
    let commitNote = "no uncommitted changes";
    if (changes.trim() !== "") {
      await runGit(path, ["add", "-A"]);
      // Artifacts in rigs carry no town vocabulary — a commit is just a commit.
      await runGit(path, ["commit", "-m", clip(row.title, 100)]);
      commitNote = "uncommitted work committed";
    }
    await runGit(path, ["push", "-u", "origin", "HEAD"]);
    const pushedBranch = branchName ?? "HEAD";
    let beadNote = "";
    if (row.bead_id) {
      try {
        await runBd(["update", row.bead_id, "--status", "review"]);
        await runBd([
          "comment",
          row.bead_id,
          `Landed: branch ${pushedBranch} pushed to origin. Awaiting the owner's merge decision.`,
        ]);
        invalidateLedger();
        beadNote = `- Bead ${row.bead_id} moved to review in the ledger.`;
      } catch (error) {
        bb.log.warn(`Bead ${row.bead_id} could not move to review: ${String(error)}`);
        beadNote = `- WARNING: bead ${row.bead_id} could not move to review (${clip(String(error), 200)}). If the status is unknown, run: bd config set status.custom review`;
      }
    }
    logEvent("land", `Landed “${row.title}” — ${pushedBranch} pushed (${commitNote})`, threadId, row.bead_id);
    return [
      `Landed “${row.title}”:`,
      `- Branch ${pushedBranch} pushed to origin (${commitNote}).`,
      beadNote,
      "The owner decides the merge path; never merge or touch a default branch without the owner's explicit say-so.",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  /** The shared shape of a deep review: mode, persona, criteria, focus. */
  type ReviewSpec = {
    mode: "lite" | "full";
    persona: string;
    criteria: string[];
    focus?: string;
  };

  function reviewSpecFrom(params: {
    mode?: "lite" | "full";
    persona?: string;
    criteria?: string[];
    focus?: string;
  }): ReviewSpec {
    return {
      mode: params.mode ?? "lite",
      persona: params.persona?.trim() || "a senior software engineer for this codebase",
      criteria: params.criteria?.length ? params.criteria : ["security", "maintainability", "performance", "quality"],
      focus: params.focus?.trim() || undefined,
    };
  }

  function reviewerPrompt(input: {
    lens: string;
    spec: ReviewSpec;
    subject: string;
    preamble: string[];
    extra?: string[];
  }): string {
    const lines = [
      `Persona: ${input.spec.persona}.`,
      `Your lens: ${input.lens}. Judge only through this lens.`,
      ...(input.spec.focus ? [`Review focus: ${input.spec.focus}`] : []),
      ...input.preamble,
      ...(input.extra ?? []),
      "",
      "Work in phases. Do them in order.",
      "",
      "Phase 1 — Find. Read the changed files and the diff. List every problem you see through your lens. Give each finding a confidence: HIGH, MEDIUM, or LOW. Include the file and line.",
      "Phase 2 — Verify. Re-check each HIGH finding against the code. Mark it CONFIRMED or REFUTED. State the evidence.",
      "Phase 3 — Report. Send polecat_report with state ready. Use exactly this format:",
      "",
      "## Findings",
      "- [HIGH] <finding> — <file>:<line>",
      "- [MEDIUM] <finding> — <file>:<line>",
      "- [LOW] <finding> — <file>:<line>",
      "",
      "## Verified",
      "- CONFIRMED: <finding> — <evidence>",
      "- REFUTED: <finding> — <why>",
      "",
      "## Verdict",
      "ship | fix — <one short reason>",
      "",
      "Rules:",
      "- Report only what you verified or saw yourself. Do not guess.",
      "- Do not modify files. A repair needs an explicit instruction from the Mayor.",
      "- Do not post anything to external services. Do not approve or reject anything.",
      "- You may run the project's tests.",
      "- Zero findings is a valid result. Say so and ship.",
    ];
    return lines.join("\n");
  }

  /** Commission independent reviews of a polecat's work (lite or full). */
  async function startReview(threadId: string, specInput: ReviewSpec, requestedBy: "mayor" | "polecat" = "mayor", options: { force?: boolean } = {}) {
    const worker = roles.get(threadId);
    if (!worker || worker.role !== "polecat") throw new Error(`No managed polecat ${threadId}.`);
    if (!options.force) {
      // A review already in flight always wins.
      const existing = db
        .prepare(`SELECT * FROM town_threads WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted','ready','blocked')`)
        .all(threadId) as ManagedRow[];
      if (existing.length > 0) {
        return { beadId: worker.bead_id, reviewers: existing.map((row) => ({ threadId: row.thread_id, title: row.title })), created: false as const };
      }
      if (requestedBy === "mayor") {
        // A verdict reported after the polecat's last report covers the work as it now stands —
        // spawning another reviewer would double-pay for the same answer.
        const fresh = db
          .prepare(`SELECT * FROM town_threads WHERE role='reviewer' AND worker_thread_id=? AND state IN ('ready','blocked') AND COALESCE(last_report_at, 0) >= ? ORDER BY COALESCE(last_report_at, 0) DESC LIMIT 1`)
          .get(threadId, worker.last_report_at ?? 0) as ManagedRow | undefined;
        if (fresh) {
          return { beadId: worker.bead_id, reviewers: [{ threadId: fresh.thread_id, title: fresh.title }], created: false as const, reused: fresh };
        }
      }
    }
    const live = await bb.sdk.threads.get({ threadId });
    // A polecat requesting review of its own work is mid-turn by definition; the
    // idle gate only guards Mayor-commissioned reviews.
    if (requestedBy !== "polecat" && BUSY_STATUSES.has(live.status)) {
      throw new Error(`Polecat ${threadId} is ${live.status}; wait until it is idle before starting a review.`);
    }
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Polecat ${threadId} is not reviewable.`);
    if (!live.environmentId) throw new Error(`Polecat ${threadId} has no reusable worktree to review.`);
    const values = await settings.get();
    const sectionId = await ensureSection();

    const reviewerSkills = await townSkillsSection(["reviewer"]);
    const lenses = specInput.mode === "full" ? specInput.criteria : [specInput.criteria.join(", ")];
    const reviewers: { threadId: string; title: string }[] = [];
    for (const lens of lenses) {
      const lensTag = specInput.mode === "full" ? ` · ${lens}` : "";
      const title = `Review · ${worker.title}${lensTag}`;
      const prompt = reviewerPrompt({
        lens,
        spec: specInput,
        subject: worker.title,
        extra: reviewerSkills,
        preamble: [
          `You review the work of another agent. The work is in this worktree.`,
          `Work under review: “${worker.title}” by thread ${threadId}.`,
          ...(requestedBy === "polecat"
            ? ["The worker who produced this work requested the review and will act on your findings. Aim your findings at them: state fixes concretely, in file/line terms."]
            : []),
        ],
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: worker.project_id,
        environment: { type: "reuse", environmentId: live.environmentId },
        sectionId,
        visibility: "visible",
        title,
        parentThreadId: requestedBy === "polecat" ? threadId : worker.mayor_thread_id ?? undefined,
        parentNotifications: "stuck",
        pluginMetadata: { role: "reviewer", beadId: worker.bead_id, rig: worker.project_id },
        ...(values.reviewerProvider ? { providerId: values.reviewerProvider as string } : {}),
        ...(values.reviewerModel ? { model: values.reviewerModel as string } : {}),
        ...(values.reviewerReasoning ? { reasoningLevel: values.reviewerReasoning as string } : {}),
        prompt,
      });
      insertThread({
        threadId: thread.id, role: "reviewer", projectId: worker.project_id,
        mayorThreadId: worker.mayor_thread_id, beadId: worker.bead_id,
        title, state: "starting", status: thread.status,
        reviewRequestedBy: requestedBy,
      });
      db.prepare(`UPDATE town_threads SET worker_thread_id=? WHERE thread_id=?`).run(threadId, thread.id);
      reloadRoles();
      reviewers.push({ threadId: thread.id, title });
      logEvent("review", `Review started for “${worker.title}” (lens: ${lens})`, thread.id, worker.bead_id);
    }
    publishTown();
    return { beadId: worker.bead_id, reviewers, created: true };
  }

  /** Review someone else's pull request as a town task: dedicated bead, visible threads. */
  async function startPrReview(params: z.infer<typeof prReviewParams>) {
    await ensureLedger();
    const spec = reviewSpecFrom(params);
    const target = await resolveRigTarget(params);
    const rigProjectId = target.projectId;
    const rigName = target.name;
    const prLabel = `${rigName}#${params.prNumber}`;
    const forge = await resolveForge(rigProjectId);
    const beadId = (await runBd([
      "create",
      `Review PR #${params.prNumber} of ${rigName}`,
      "-d",
      [
        `Review the pull request ${prLabel} and report findings with confidence ratings.`,
        ...(spec.focus ? [`Focus: ${spec.focus}`] : []),
        `Mode: ${spec.mode}. Criteria: ${spec.criteria.join(", ")}.`,
      ].join("\n"),
      "-l",
      rigName,
      "--silent",
    ])).trim();
    invalidateLedger();
    const values = await settings.get();
    const sectionId = await ensureSection();
    const hostId = await defaultHostId();

    const reviewerSkills = await townSkillsSection(["reviewer"]);
    const lenses = spec.mode === "full" ? spec.criteria : [spec.criteria.join(", ")];
    const reviewers: { threadId: string; title: string }[] = [];
    for (const lens of lenses) {
      const lensTag = spec.mode === "full" ? ` · ${lens}` : "";
      const title = `PR review · ${prLabel}${lensTag}`;
      const prompt = reviewerPrompt({
        lens,
        spec,
        subject: title,
        extra: reviewerSkills,
        preamble: [
          `You review a pull request of repository ${rigName}. Pull request: #${params.prNumber}.`,
          ...forgeLines(forge.forge, forge.cli),
          "This is a review task. You do not write code for it.",
          "",
          "Do this first:",
          ...prCommands(forge.forge, forge.cli, params.prNumber),
        ],
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: rigProjectId,
        environment: {
          type: "host",
          hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
        },
        sectionId,
        visibility: "visible",
        title,
        parentThreadId: mayorRow()?.thread_id ?? undefined,
        parentNotifications: "stuck",
        pluginMetadata: { role: "polecat", beadId, rig: rigProjectId },
        permissionMode: (values.polecatPermissionMode as SpawnPermissionMode) || "accept-edits",
        ...(values.reviewerProvider ? { providerId: values.reviewerProvider as string } : {}),
        ...(values.reviewerModel ? { model: values.reviewerModel as string } : {}),
        ...(values.reviewerReasoning ? { reasoningLevel: values.reviewerReasoning as string } : {}),
        prompt,
      });
      insertThread({
        threadId: thread.id, role: "polecat", projectId: rigProjectId,
        mayorThreadId: mayorRow()?.thread_id ?? null, beadId, title,
        state: "starting", status: thread.status,
      });
      reviewers.push({ threadId: thread.id, title });
      logEvent("review", `PR review started: ${prLabel} (lens: ${lens})`, thread.id, beadId);
    }
    publishTown();
    return { beadId, pr: prLabel, reviewers, created: true };
  }

  // ── Adoption: bring existing threads and PRs into the town ───────────

  /** Adopt an existing bb thread into a town role. */
  async function adoptThread(params: z.infer<typeof adoptParams>) {
    const role = params.role ?? "polecat";
    const thread = await bb.sdk.threads.get({ threadId: params.threadId });
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      throw new Error(`${params.threadId} is not a live thread.`);
    }
    const sectionId = await ensureSection();
    let bead: Bead | null = null;
    if (params.beadId) {
      await ensureLedger();
      const found = await bdJson<Bead[]>(["show", params.beadId]).catch(() => null);
      bead = found?.[0] ?? null;
      if (!bead) throw new Error(`No bead ${params.beadId} in the town ledger.`);
      if (bead.status !== "closed") {
        await runBd(["update", bead.id, "--claim"]);
        invalidateLedger();
      }
    }
    const townId = await configuredTownProject();
    const title =
      role === "mayor"
        ? `Mayor · ${await projectName(townId ?? thread.projectId)}`
        : (thread.title ?? `Adopted ${role}`);
    if (role === "mayor") {
      if (!townId) throw new Error(await noTownMessage());
      if (thread.projectId !== townId) {
        throw new Error(
          `A Mayor must live in the town project (${townId}); ${params.threadId} is in ${thread.projectId}. Adopt it as a polecat instead, or move the town.`,
        );
      }
    }
    await bb.sdk.threads.update({
      threadId: params.threadId,
      sectionId,
      visibility: "visible",
      ...(role === "mayor" ? { title } : {}),
    });
    // Replacing a Mayor: retire the old one and re-point its polecats and
    // any undelivered alerts at the adopted thread.
    const previous = role === "mayor" ? mayorRow() : null;
    if (previous && previous.thread_id !== params.threadId) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE town_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
        db.prepare(`UPDATE town_threads SET mayor_thread_id=?, updated_at=?
          WHERE mayor_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(
          params.threadId, now, previous.thread_id,
        );
        db.prepare(`UPDATE alert_outbox SET target_thread_id=?
          WHERE target_thread_id=? AND delivered_at IS NULL`).run(params.threadId, previous.thread_id);
      })();
    }
    insertThread({
      threadId: params.threadId,
      role,
      projectId: thread.projectId,
      mayorThreadId: role === "mayor" ? null : (mayorRow()?.thread_id ?? null),
      beadId: bead?.id ?? null,
      title,
      state: BUSY_STATUSES.has(thread.status) ? "active" : "idle",
      status: thread.status,
    });
    logEvent(
      "adopt",
      `Thread “${title}” adopted as ${role}${bead ? ` (bead ${bead.id})` : ""}`,
      params.threadId,
      bead?.id ?? null,
    );
    return { threadId: params.threadId, role, beadId: bead?.id ?? null };
  }

  /** Adopt an external pull request for town maintenance: dedicated bead + maintainer. */
  async function adoptPr(params: z.infer<typeof adoptPrParams>) {
    await ensureLedger();
    const target = await resolveRigTarget(params);
    const prLabel = `${target.name}#${params.prNumber}`;
    const forge = await resolveForge(target.projectId);
    const beadId = (await runBd([
      "create",
      `Maintain PR #${params.prNumber} of ${target.name}`,
      "-d",
      [
        `Adopt pull request ${prLabel} for town maintenance.`,
        "Keep CI green, address review feedback, and drive the PR to merge readiness.",
        "Pushes to the PR branch are authorized; posting comments, approvals, and merges stay owner-approved.",
      ].join("\n"),
      "-l",
      target.name,
      "--silent",
    ])).trim();
    invalidateLedger();
    const values = await settings.get();
    const sectionId = await ensureSection();
    const hostId = await defaultHostId();
    const adoptSkills = await townSkillsSection(["polecat"]);
    const title = `PR maintain · ${prLabel}`;
    const prompt = [
      `You maintain a pull request. The town adopted it.`,
      `Repository: ${target.name}. Pull request: #${params.prNumber}.`,
      ...adoptSkills,
      "",
      "Do this:",
      ...prCommands(forge.forge, forge.cli, params.prNumber),
      "4. Read the review comments. Read the failed checks, if any.",
      "5. Fix what is broken. Commit your fixes. Push to the pull request branch.",
      "6. Check the state again after each push.",
      "",
      "Rules:",
      "- Push commits to the pull request branch when you fix something.",
      "- Do not post comments, reviews, or approvals. Do not merge. Those need the owner's approval through the Mayor.",
      "- Do not force-push. Do not delete the branch.",
      "- Commit messages and pull request text read like a normal engineer wrote them. No internal vocabulary.",
      "- If a review comment asks for a product decision you cannot make, report blocked.",
      "",
      "Report:",
      "- Use polecat_report with state ready when the PR is green and the review feedback is addressed.",
      "- Use polecat_report with state blocked when something needs the owner.",
      "- List: what you fixed, the check status, and the review comments that remain.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      sectionId,
      visibility: "visible",
      title,
      parentThreadId: mayorRow()?.thread_id ?? undefined,
      parentNotifications: "stuck",
      pluginMetadata: { role: "polecat", beadId, rig: target.projectId },
      permissionMode: (values.polecatPermissionMode as SpawnPermissionMode) || "accept-edits",
      prompt,
    });
    insertThread({
      threadId: thread.id, role: "polecat", projectId: target.projectId,
      mayorThreadId: mayorRow()?.thread_id ?? null, beadId, title,
      state: "starting", status: thread.status,
    });
    logEvent("adopt", `PR ${prLabel} adopted for maintenance`, thread.id, beadId);
    return { beadId, pr: prLabel, threadId: thread.id };
  }

  // ── Patrol roles: the Buzzard (cruft) and the Imperator (security) ──

  function patrolSettingsPrefix(role: PatrolRole) {
    return role === "buzzard" ? "buzzard" : "imperator";
  }

  function buzzardBrief(rigName: string, includeUnmaintained: boolean, forge: { forge: Forge; cli: ForgeCli }): string {
    const prListCheck =
      forge.cli === "gh"
        ? "4. Abandoned pull requests. Check: gh pr list --state open --json number,title,isDraft,updatedAt. Flag drafts and stale PRs with no activity."
        : forge.cli === "glab"
          ? "4. Abandoned merge requests. Check: glab mr list --state opened. Flag draft MRs and stale ones with no activity."
          : forge.cli === "gt"
            ? "4. Abandoned pull requests. Check: gt pr list --state open. Flag drafts and stale PRs."
            : forge.cli === "tea"
            ? "4. Abandoned pull requests. Check: tea pr ls. Flag drafts and stale PRs."
            : "4. Pull requests: no forge CLI detected — skip this check.";
    const draftPrCmd = forge.cli === "gh" ? "gh pr create --draft" : forge.cli === "glab" ? "glab mr create --draft" : forge.cli === "gt" ? "gt pr create --draft" : "tea pr create --draft";
    const draftPrLine = forge.cli
      ? `- You may open ONE draft ${forge.cli === "glab" ? "merge request" : "pull request"} for safe removals (dead code, obvious comments, unused dependencies). Use: ${draftPrCmd}.`
      : "- No forge CLI is available: do NOT open any pull or merge requests. Report the findings; the owner will open one if wanted.";
    return [
      `You are a Buzzard. You circle a repository and pick it clean.`,
      `Repository: ${rigName}. Work in your worktree.`,
      ...forgeLines(forge.forge, forge.cli),
      "",
      "Look for:",
      "1. Pointless tests. Tests that assert nothing real.",
      "2. Obvious comments. Comments that only repeat the code next to them.",
      "3. Dead code. Code nothing calls. Old paths. Unused exports.",
      prListCheck,
      "5. Unused dependencies. Use the project's own tooling when it has one (for example knip or depcheck for JavaScript, mix xref or unused for Elixir).",
      ...(includeUnmaintained
        ? [
            "6. Unmaintained dependencies. Check each dependency's health: last release, last commit, archived status. Name a better-maintained alternative when one exists.",
          ]
        : []),
      "",
      "Rules:",
      "- Report every finding. Give the file, or the PR link.",
      draftPrLine,
      "- The draft PR title and description must read like a normal cleanup PR. No internal vocabulary.",
      "- Never open a ready (non-draft) pull request. The Mayor decides when a draft goes ready.",
      "- Do not post comments or reviews on other people's pull requests.",
      "- Do not delete anything outside your worktree.",
      "",
      "Report:",
      "- Use polecat_report with state ready.",
      "- List each finding with its evidence.",
      "- Put the draft PR link in the report, if you made one.",
      "- Recommend an action per finding: remove, fix, or leave with a reason.",
    ].join("\n");
  }

  function imperatorBrief(rigName: string): string {
    return [
      `You are an Imperator. You patrol a repository for security problems.`,
      `Repository: ${rigName}. Work in your worktree.`,
      "",
      "Look for:",
      "1. Secrets in the code. Keys, tokens, passwords, credentials in files or history.",
      "2. Insecure code. Injection, unsafe deserialization, weak crypto, broken access control.",
      "3. Risky dependencies. Check for known advisories (osv.dev, GitHub advisories).",
      "4. Unsafe configuration. Debug flags, open ports, permissive permissions.",
      "",
      "Rules:",
      "- This is a security patrol. Report ONLY to the Mayor.",
      "- Do not create issues. Do not create pull requests. Do not post anything anywhere.",
      "- Do not change code. Do not push. Do not open draft pull requests.",
      "",
      "Report:",
      "- Use polecat_report with state ready.",
      "- Give each finding: severity (critical, high, medium, low), confidence (HIGH, MEDIUM, LOW), file and line, evidence.",
      "- Say clearly what an attacker could do, if the finding is real.",
    ].join("\n");
  }

  /** Resolve a rig target: registered id, or find-or-create by git URL. */
  async function resolveRigTarget(params: { rigProjectId?: string; gitUrl?: string }): Promise<{
    projectId: string;
    name: string;
  }> {
    if (params.rigProjectId) {
      if (!isRig(params.rigProjectId)) {
        throw new Error(`Project ${params.rigProjectId} is not a registered rig. Register it first: bb madmax rig add ${params.rigProjectId}`);
      }
      const row = rigById.get(params.rigProjectId) as RigRow;
      return { projectId: row.project_id, name: row.name };
    }
    if (params.gitUrl) {
      const derived = rigNameFromUrl(params.gitUrl);
      const known = (allRigs.all() as RigRow[]).find((row) => row.name === derived);
      if (known) return { projectId: known.project_id, name: known.name };
      const created = await createRig({ gitUrl: params.gitUrl });
      return { projectId: created.projectId, name: created.name };
    }
    throw new Error("Give the target: rigProjectId of a registered rig, or gitUrl to find or create one.");
  }

  function patrolActive(role: PatrolRole, projectId: string): boolean {
    return [...roles.values()].some(
      (row) =>
        row.role === role &&
        row.project_id === projectId &&
        !["complete", "archived", "deleted", "failed", "blocked", "ready", "idle"].includes(row.state),
    );
  }

  async function dispatchPatrol(
    role: PatrolRole,
    options: { rigProjectId?: string; gitUrl?: string; includeUnmaintained?: boolean; reason: "schedule" | "demand" },
  ) {
    if (!mayorRow()) {
      throw new Error("No Mayor thread is running; start the Mayor first (bb madmax start).");
    }
    const target = await resolveRigTarget(options);
    const patrolForge = await resolveForge(target.projectId);
    if (patrolActive(role, target.projectId)) {
      return { skipped: true as const, projectId: target.projectId, name: target.name };
    }
    const values = await settings.get();
    const prefix = patrolSettingsPrefix(role);
    const sectionId = await ensureSection();
    const hostId = await defaultHostId();
    const title = `${role === "buzzard" ? "Buzzard" : "Imperator"} · ${target.name}`;
    const patrolSkills = await townSkillsSection([role]);
    const prompt = [
      role === "buzzard"
        ? buzzardBrief(target.name, options.includeUnmaintained ?? (values.buzzardUnmaintained as boolean), patrolForge)
        : imperatorBrief(target.name),
      ...patrolSkills,
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      sectionId,
      visibility: "visible",
      title,
      parentThreadId: mayorRow()?.thread_id ?? undefined,
      parentNotifications: "stuck",
      pluginMetadata: { role, rig: target.projectId },
      permissionMode: (values.polecatPermissionMode as SpawnPermissionMode) || "accept-edits",
      ...(values[`${prefix}Provider`] ? { providerId: values[`${prefix}Provider`] as string } : {}),
      ...(values[`${prefix}Model`] ? { model: values[`${prefix}Model`] as string } : {}),
      ...(values[`${prefix}Reasoning`] ? { reasoningLevel: values[`${prefix}Reasoning`] as string } : {}),
      prompt,
    });
    insertThread({
      threadId: thread.id, role, projectId: target.projectId,
      mayorThreadId: mayorRow()?.thread_id ?? null, title,
      state: "starting", status: thread.status,
    });
    logEvent(
      "patrol",
      `${role === "buzzard" ? "Buzzard" : "Imperator"} dispatched to ${target.name} (${options.reason})`,
      thread.id,
    );
    return { skipped: false as const, threadId: thread.id, title, projectId: target.projectId, name: target.name };
  }

  /** Scheduled sweeps: one patrol per registered rig, skipping active ones. */
  async function runPatrolSweep(role: PatrolRole, includeUnmaintained?: boolean): Promise<void> {
    const rigs = allRigs.all() as RigRow[];
    const dispatched: string[] = [];
    const skipped: string[] = [];
    for (const rig of rigs) {
      const result = await dispatchPatrol(role, {
        rigProjectId: rig.project_id,
        includeUnmaintained,
        reason: "schedule",
      }).catch((error) => {
        bb.log.warn(`Scheduled ${role} sweep failed for ${rig.name}: ${String(error)}`);
        return null;
      });
      if (result === null) continue;
      if (result.skipped) skipped.push(rig.name);
      else dispatched.push(rig.name);
    }
    logEvent(
      "patrol",
      `${role} sweep: ${dispatched.length} dispatched${skipped.length ? `, ${skipped.length} skipped (already active)` : ""}`,
    );
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
    // Repair a thread bb left untitled (e.g. spawned without title at a
    // buggy version) by re-asserting the title we track it under.
    if (thread.title === null && row.title) {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, title: row.title });
      } catch (error) {
        bb.log.warn(`Transient title repair failure for ${row.thread_id}; will retry: ${String(error)}`);
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
      logEvent("unarchived", `${row.role} “${row.title}” came back from the archive`, row.thread_id);
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
    logEvent(kind, `${current.role} “${current.title}” is ${observed}`, row.thread_id, current.bead_id);
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
          await pollPrWatch().catch((error) => bb.log.warn(`PR watch poll failed: ${String(error)}`));
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
              logEvent("stall", `“${row.title}” active for over ${Math.round(threshold / 60_000)} minutes`, row.thread_id, row.bead_id);
            }
          }
          // Keep claimed beads' leases alive while their polecats run; a
          // lost lease means the bead was reclaimed or closed out from
          // under a running thread, and the Mayor should decide.
          for (const row of [...roles.values()]) {
            if (row.role === "mayor" || row.state !== "active" || row.active_since === null || !row.bead_id) continue;
            try {
              await runBd(["heartbeat", row.bead_id]);
            } catch (error) {
              bb.log.warn(`Heartbeat failed for bead ${row.bead_id}: ${String(error)}`);
              logEvent("lease", `Claim lease lost for bead ${row.bead_id} (“${row.title}”)`, row.thread_id, row.bead_id);
              await alertMayor(row, `lease:${row.active_cycle}`, [
                `The claim lease for bead ${row.bead_id} (“${row.title}”) could not be refreshed.`,
                "The bead may have been reclaimed or closed while its polecat still runs. Inspect and decide: nudge, re-sling, or complete.",
              ].join("\n")).catch(() => false);
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

  // Scheduled patrols (settings are read once per load; reload the plugin
  // after changing a patrol cron).
  const patrolValues = await settings.get();
  const buzzardCron = ((patrolValues.buzzardCron as string | undefined) ?? "").trim();
  if (buzzardCron !== "") {
    try {
      bb.background.schedule("buzzard-sweep", buzzardCron, () => runPatrolSweep("buzzard"));
    } catch (error) {
      bb.log.warn(`Buzzard schedule not registered: ${String(error)}`);
    }
  }
  const imperatorCron = ((patrolValues.imperatorCron as string | undefined) ?? "").trim();
  if (imperatorCron !== "") {
    try {
      bb.background.schedule("imperator-patrol", imperatorCron, () => runPatrolSweep("imperator"));
    } catch (error) {
      bb.log.warn(`Imperator schedule not registered: ${String(error)}`);
    }
  }

  function belongsToMayor(row: ManagedRow, mayorThreadId: string) {
    return row.thread_id === mayorThreadId || row.mayor_thread_id === mayorThreadId;
  }

  function rosterForMayor(mayorThreadId: string, includeComplete = false) {
    return [...roles.values()].filter(
      (row) => belongsToMayor(row, mayorThreadId) && row.role !== "mayor" && (includeComplete || row.state !== "complete"),
    );
  }

  async function buildStatus() {
    const mayor = mayorRow();
    return {
      sectionId: storedSectionId(),
      townProjectId: await configuredTownProject(),
      mayor: mayor ? toManaged(mayor) : null,
      threads: [...roles.values()].map(toManaged),
      rigs: (allRigs.all() as RigRow[]).map((row) => ({ projectId: row.project_id, name: row.name, forge: row.forge ?? null, registeredAt: row.registered_at })),
      ledger: await ledgerBlock(),
    };
  }

  bb.agents.registerTool({
    name: "town_sling",
    description: "Sling one clearly titled, self-contained work item to a polecat worker thread in its own managed worktree. A bead is filed in the town ledger automatically when none is given, so the work shows up on the board.",
    parameters: slingParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_sling requires an active registered Mayor thread.");
      }
      const result = await sling(params, context.threadId);
      return `Slung “${result.title}” to a polecat in thread ${result.threadId} (tier ${result.tier}, project ${result.projectId}${result.beadId ? `, bead ${result.beadId}` : ""}). Track it with town_roster.`;
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
    description: "Send a self-contained instruction to a managed polecat or reviewer. Steer only to interrupt a thread working something wrong right now.",
    parameters: z.object({
      threadId: z.string(),
      text: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
      steer: z.boolean().optional().describe("Interrupt the running turn instead of queuing behind it."),
      authorizeEdits: z.boolean().optional().describe("For reviewers: explicitly authorize a repair pass (edits allowed) for this instruction."),
    }),
    async execute({ threadId, text, steer, authorizeEdits }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Mayor.`);
      }
      await nudge(threadId, text, steer, authorizeEdits);
      return `Nudged ${threadId}${steer ? " (steering the running turn)" : " (queued)"}${authorizeEdits ? " with repair authorization" : ""}.`;
    },
  });
  bb.agents.registerTool({
    name: "town_review",
    description: "Commission an owner-requested adversarial review of a polecat's work, in its own worktree. Polecats request their own reviews in their fix loop; use this only for an owner-commissioned deep dive. If a fresh verdict on the current work already exists (e.g. from the polecat's own review), returns it instead of spawning a duplicate — pass force: true to insist on an independent pass. Lite: one reviewer covers all criteria. Full: one reviewer per criterion. Reviewers report to you; the polecat's own reviews report to the polecat.",
    parameters: reviewParams.extend({
      force: z.boolean().optional().describe("Spawn a fresh review even when a fresh verdict on the current work already exists."),
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(params.threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${params.threadId} for this Mayor.`);
      }
      const result = await startReview(params.threadId, reviewSpecFrom(params), "mayor", { force: params.force });
      const reused = "reused" in result ? result.reused : undefined;
      if (reused) {
        return [
          `A fresh review of this work already exists: ${reused.title} (${reused.state}). Not spawning a duplicate.`,
          reused.result ? `Its report:\n${clip(reused.result, 2_000)}` : "No findings summary on record; inspect the reviewer thread for the full report.",
          "Pass force: true to commission an independent pass anyway.",
        ].join("\n");
      }
      const lensList = result.reviewers.map((reviewer) => reviewer.title).join("; ");
      return [
        `${result.created ? "Started" : "Already running"}: ${lensList}.`,
        "When the reviewer(s) report: compile the CONFIRMED findings, nudge the worker to fix them, and repeat the review until the verdict is ship. Only then land.",
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_pr_review",
    description: "Review someone else's pull request as a town task: finds or creates the rig, mints a dedicated bead, and spawns reviewer threads in that project that check out the PR and report findings with confidence ratings. Use when the owner points at a PR link and wants a review.",
    parameters: prReviewParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_pr_review requires an active registered Mayor thread.");
      }
      const result = await startPrReview(params);
      const reviewerList = result.reviewers.map((reviewer) => reviewer.title).join("; ");
      return [
        `PR review of ${result.pr} is running (bead ${result.beadId}): ${reviewerList}.`,
        "When the reviewer(s) report: compile the CONFIRMED findings, present them to the owner, and draft the PR response (approve, comment, or request changes). The owner decides whether to post it.",
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_verify",
    description: "Gather deterministic evidence from a managed thread's worktree: git status, diff stat, and recent log — before deciding to review or land.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Mayor.`);
      }
      return verify(threadId);
    },
  });
  bb.agents.registerTool({
    name: "town_land",
    description: "Deliver verified work: commit any uncommitted polecat work, push its branch to the rig's origin, and move the bead to review. The owner alone decides the merge.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Mayor.`);
      }
      return land(threadId);
    },
  });
  bb.agents.registerTool({
    name: "town_create_rig",
    description: "Clone a git repository and register it as a town rig so work can be slung into it. Use when the owner wants to work on a repo the town doesn't know yet.",
    parameters: createRigParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_create_rig requires an active registered Mayor thread.");
      }
      const result = await createRig(params);
      return [
        `Rig “${result.name}” is ready (${result.projectId}), cloned to ${result.path}.`,
        `Sling into it with town_sling rigProjectId=${result.projectId} (or tag beads with the label “${result.name}”).`,
        `Forge: ${(await inferForgeFromRemote(result.projectId)) ?? "not recognized from the remote URL"} — if unknown or wrong, ask the owner which forge the repo lives on and record it with town_set_rig_forge.`,
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_set_rig_forge",
    description: "Pin (or clear) the forge for a rig: which CLI the town uses for its pull/merge requests. Use when the forge cannot be inferred from the remote (e.g. a homelab host such as https://git.example.com) or when inference guessed wrong. Accepts gh, glab, gt (gitea-cli), tea (legacy), none, or auto (clear the pin and infer from the remote again).",
    parameters: z.object({
      projectId: z.string().describe("The rig's project id."),
      forge: z.string().describe("gh | glab | gt | tea | none (never forge-aware) | auto (clear the pin, infer from remote). Aliases: github→gh, gitlab→glab, gitea/forgejo/gitea-cli→gt."),
    }),
    async execute({ projectId, forge }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_set_rig_forge requires an active registered Mayor thread.");
      }
      const normalized = forge.trim().toLowerCase();
      const pin = FORGE_ALIASES[normalized] ?? normalized;
      if (!["gh", "glab", "gt", "tea", "none", "auto"].includes(pin)) {
        throw new Error(`Unknown forge “${forge}”. Use one of: gh, glab, gt, tea, none, auto.`);
      }
      const rig = rigById.get(projectId) as RigRow | undefined;
      if (!rig) throw new Error(`No rig registered for project ${projectId}.`);
      const value = pin === "auto" ? null : pin;
      db.prepare(`UPDATE rigs SET forge=? WHERE project_id=?`).run(value, projectId);
      publishTown();
      logEvent("rig", `Forge for rig ${rig.name} ${value ? `pinned to ${value}` : "pin cleared (auto-infer from remote)"}`);
      const effective = await resolveForge(projectId);
      const cli = effective.cli ?? "none available — briefs will tell workers not to run forge commands";
      return `Forge for rig “${rig.name}” set to ${value ?? "auto"} (effective: ${effective.forge ?? "none"} via ${cli}).`;
    },
  });
  bb.agents.registerTool({
    name: "town_convoy",
    description: "Create a convoy (epic) with self-contained beads in the town ledger, ready for slinging.",
    parameters: convoyParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_convoy requires an active registered Mayor thread.");
      }
      await ensureLedger();
      const epicArgs = ["create", params.goal, "--type=epic", "-p", "1", "--silent"];
      if (params.description) epicArgs.push("-d", params.description);
      const epicId = (await runBd(epicArgs)).trim();
      const beadIds: string[] = [];
      for (const [index, bead] of params.beads.entries()) {
        const args = [
          "create", bead.title, "--parent", epicId,
          "-p", String(bead.priority ?? 2),
          "-d", bead.description,
          "--silent",
        ];
        const label = bead.rig ?? params.rig;
        if (label) args.push("-l", label);
        if (bead.dependsOn?.length) {
          const deps = bead.dependsOn.map((depIndex) => {
            const target = beadIds[depIndex];
            if (!target) {
              throw new Error(
                `Bead ${index} depends on bead ${depIndex}, which does not exist yet; dependsOn must reference earlier beads.`,
              );
            }
            return `blocked-by:${target}`;
          });
          args.push("--deps", deps.join(","));
        }
        beadIds.push((await runBd(args)).trim());
      }
      invalidateLedger();
      logEvent("convoy", `Convoy created: ${params.goal} (${epicId}, ${beadIds.length} beads)`, null, epicId);
      publishTown();
      return [
        `Convoy created: ${params.goal} (${epicId}).`,
        ...beadIds.map((id, index) => {
          const bead = params.beads[index]!;
          return `${id}  ${bead.title}${bead.dependsOn?.length ? " (blocked)" : ""}${bead.rig ?? params.rig ? ` [${bead.rig ?? params.rig}]` : ""}`;
        }),
        "Sling each with town_sling (beadId + an honest tier); find claimable work any time with town_ready.",
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_ready",
    description: "List ready beads (open, unblocked, not epics) from the town ledger with their labels.",
    parameters: z.object({}).strict(),
    async execute(_params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor") throw new Error("town_ready requires a registered Mayor thread.");
      await ensureLedger();
      const ready = (await bdJson<Bead[]>(["ready"])).filter((bead) => bead.issue_type !== "epic");
      return ready.length
        ? ready
            .map((bead) => `${bead.id}  ${bead.title}${bead.labels?.length ? ` [${bead.labels.join(", ")}]` : ""} (p${bead.priority ?? "?"})`)
            .join("\n")
        : "No ready beads in the town ledger.";
    },
  });
  bb.agents.registerTool({
    name: "town_complete",
    description: "Mark a managed thread complete after verifying its evidence; closes the linked bead in the ledger and, by default, archives the thread so bb can clean up its worktree (skipped while reviewers are still running against it).",
    parameters: completeParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(params.threadId);
      if (!caller || caller.role !== "mayor" || !target || !belongsToMayor(target, caller.thread_id)) {
        throw new Error(`No managed thread ${params.threadId} for this Mayor.`);
      }
      const result = await complete(params.threadId, params.result, { archive: params.archive });
      return `Marked “${result.title}” complete.${result.note}`;
    },
  });
  bb.agents.registerTool({
    name: "polecat_report",
    description: "Report managed work state and evidence. Polecats report to the Mayor; reviewers report to whoever commissioned the review. Use ready, not complete; blocked requires blocker and recommendation.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("polecat_report requires a thread context.");
      await report(context.threadId, params);
      return "Report delivered.";
    },
  });
  bb.agents.registerTool({
    name: "polecat_request_review",
    description: "Request an adversarial review of YOUR OWN work. Reviewers work in your worktree and report their findings to this thread; fix what they find, then request again until a verdict is ship — then call polecat_report with state ready. Use when your work is complete and you want it verified before reporting ready.",
    parameters: z.object({
      focus: z.string().trim().max(4_000).optional().describe("What the review should concentrate on."),
      ...reviewSpecParams,
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!context.threadId || !caller || caller.role !== "polecat" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("polecat_request_review is only available in an active managed polecat thread.");
      }
      const spec = reviewSpecFrom(params);
      const result = await startReview(caller.thread_id, spec, "polecat");
      if (!result.created) {
        return `A review of your work is already in progress (${result.reviewers.map((r) => r.title).join("; ")}). Wait for their findings in this thread.`;
      }
      return [
        `Review requested (${spec.mode}): ${result.reviewers.map((r) => r.title).join("; ")}.`,
        "The reviewer(s) work in your worktree and their findings will arrive in this thread.",
        "Fix what they find, commit, and request a fresh review until the verdict is ship — then report ready.",
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "town_buzzard",
    description: "Dispatch a Buzzard to a rig on demand: it circles the repo for pointless tests, obvious comments, dead code, abandoned PRs, and unused dependencies (optionally unmaintained ones), and reports to you with an optional draft cleanup PR.",
    parameters: z.object({
      rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project to sweep."),
      gitUrl: z.string().trim().min(1).max(2_000).optional().describe("Repository URL; finds or creates the rig."),
      includeUnmaintained: z.boolean().optional().describe("Also flag unmaintained dependencies and better-maintained alternatives."),
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_buzzard requires an active registered Mayor thread.");
      }
      const result = await dispatchPatrol("buzzard", { ...params, reason: "demand" });
      if (result.skipped) {
        return `A Buzzard is already circling ${result.name}; it will report when done.`;
      }
      return [
        `Buzzard dispatched to ${result.name} (thread ${result.threadId}).`,
        "When it reports: review the findings. If it made a draft PR, approve or reject it. On approval, mark it ready (gh pr ready) yourself — or ask the owner first for anything risky.",
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_imperator",
    description: "Dispatch an Imperator to a rig on demand: it patrols for security problems (secrets, insecure code, risky dependencies, unsafe configuration) and reports ONLY to you. It never posts findings externally.",
    parameters: z.object({
      rigProjectId: z.string().trim().min(1).optional().describe("Registered rig project to patrol."),
      gitUrl: z.string().trim().min(1).max(2_000).optional().describe("Repository URL; finds or creates the rig."),
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_imperator requires an active registered Mayor thread.");
      }
      const result = await dispatchPatrol("imperator", { ...params, reason: "demand" });
      if (result.skipped) {
        return `An Imperator is already patrolling ${result.name}; it will report when done.`;
      }
      return [
        `Imperator dispatched to ${result.name} (thread ${result.threadId}).`,
        "When it reports: assess and verify the findings yourself before raising anything to the owner. Security findings go to the owner in this thread only — never as public issues or PRs.",
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "town_adopt",
    description: "Adopt an existing bb thread into the town — bring pre-madmax work under management as a polecat (optionally owning a ledger bead), or make an existing thread the new Mayor.",
    parameters: adoptParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_adopt requires an active registered Mayor thread.");
      }
      const result = await adoptThread(params);
      return [
        `Adopted thread ${result.threadId} as ${result.role}${result.beadId ? ` (bead ${result.beadId})` : ""}.`,
        result.role === "mayor"
          ? "The previous Mayor is retired; its polecats and pending alerts now report to this thread."
          : "It now files in the Town section, reports through polecat_report, and appears on the roster.",
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "town_adopt_pr",
    description: "Adopt a pull request created outside the town: finds or creates the rig, mints a dedicated bead, and spawns a maintainer polecat that keeps CI green and addresses review feedback. Posting comments and merging stay owner-approved.",
    parameters: adoptPrParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "mayor" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("town_adopt_pr requires an active registered Mayor thread.");
      }
      const result = await adoptPr(params);
      return [
        `Adopted PR ${result.pr} for maintenance (bead ${result.beadId}, maintainer thread ${result.threadId}).`,
        "When it reports: relay anything the owner must decide. Comments, approvals, and the merge stay owner-approved.",
      ].join("\n");
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
    // rulesCache is refreshed on every spawn, reconcile cycle, and readRules call.
    if (role === "mayor") {
      return {
        tools: ["town_sling", "town_roster", "town_inspect", "town_nudge", "town_convoy", "town_ready", "town_complete", "town_review", "town_verify", "town_land", "town_create_rig", "town_set_rig_forge", "town_pr_review", "town_buzzard", "town_imperator", "town_adopt", "town_adopt_pr"],
        skills: ["mayor"],
        instructions: `You are the registered Mayor supervising the town's polecat threads from ${context.project.name}. Decompose goals into convoys (town_convoy), sling beads to polecats (town_sling), and drive work through verification (town_verify) and delivery (town_land) to verified completion (town_complete). Polecats review their own work before reporting ready.\n\n${rules}`,
      };
    }
    if (role === "buzzard") {
      return {
        tools: ["polecat_report"],
        skills: ["polecat"],
        instructions: `You are the town's Buzzard: circle the repo, pick it clean, and report to the Mayor. Cleanup pull requests stay drafts until the Mayor or the owner approves them.\n\n${rules}`,
      };
    }
    if (role === "imperator") {
      return {
        tools: ["polecat_report"],
        skills: ["polecat"],
        instructions: `You are the town's Imperator: patrol for security problems. Report ONLY to the Mayor in this thread; never create issues, PRs, or public posts about security findings.\n\n${rules}`,
      };
    }
    if (role === "polecat") {
      return {
        tools: ["polecat_report", "polecat_request_review"],
        skills: ["polecat"],
        instructions: `You are a managed polecat reporting to the Mayor of this town.\n\n${rules}`,
      };
    }
    return {
      tools: ["polecat_report"],
      skills: ["polecat"],
      instructions: `You are a managed ${role} reporting to the Mayor of this town.\n\n${rules}`,
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => buildStatus(),
    start: ({ projectId }) => ensureMayor(projectId ?? undefined),
    rigAdd: ({ projectId, forge }) => addRig(projectId, forge),
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
    ledgerInit: () => initLedger(),
    townHall: async () => {
      const [status, board] = await Promise.all([buildStatus(), ledgerBoard()]);
      return { status, convoys: board.convoys, looseBeads: board.looseBeads, events: recentEvents() };
    },
    browseTownDirectories: async ({ path }) => {
      const hostId = await defaultHostId();
      const listing = await bb.sdk.hosts.directory({ hostId, ...(path ? { path } : {}) });
      const directories = listing.entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => ({ name: entry.name, path: entry.path }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        hostId,
        directory: listing.directory,
        parent: listing.parent,
        roots: listing.roots,
        directories,
      };
    },
  });

  const usage = [
    "Usage:",
    "  bb madmax status [--json]",
    "  bb madmax start [--project <proj-id>] [--json]",
    "  bb madmax init --project <proj-id>",
    "  bb madmax init --path <dir> --name <name> [--host <host-id>]",
    "  bb madmax ledger init",
    "  bb madmax ledger status [--json]",
    "  bb madmax rig list [--json]",
    "  bb madmax rig add <project-id>",
    "  bb madmax rig remove <project-id>",
    "  bb madmax rig forge <project-id> <gh|glab|gt|tea|none|auto>",
    "  bb madmax rig clone <git-url> [--name <name>] [--json]",
    "  bb madmax sling --bead <bead-id> [--rig <project-id>] [--tier <tier>] [--json]",
    "  bb madmax sling --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--rig <project-id>] [--tier <tier>] [--json]",
    "  bb madmax nudge <thread-id> --text \"…\" [--steer] [--authorize-edits] [--json]",
    "  bb madmax inspect <thread-id>",
    "  bb madmax review <thread-id> [--focus \"…\"] [--mode lite|full] [--json]",
    "  bb madmax verify <thread-id>",
    "  bb madmax land <thread-id>",
    "  bb madmax buzzard --rig <project-id> [--unmaintained] [--json]",
    "  bb madmax buzzard --git-url <url> [--unmaintained] [--json]",
    "  bb madmax imperator --rig <project-id> [--json]",
    "  bb madmax imperator --git-url <url> [--json]",
    "  bb madmax adopt --thread <thread-id> [--role mayor|polecat] [--bead <bead-id>] [--json]",
    "  bb madmax adopt-pr --git-url <url> --pr <number> [--json]",
    "  bb madmax adopt-pr --rig <project-id> --pr <number> [--json]",
  ].join("\n");

  bb.cli.register({
    name: "madmax",
    summary: "Run the town: a Mayor that slings work to polecat threads across rigs",
    commands: [
      { name: "status", summary: "Show the town's roster", usage: "bb madmax status [--json]" },
      { name: "start", summary: "Start or return the town's Mayor", usage: "bb madmax start [--project <proj-id>] [--json]" },
      { name: "init", summary: "Choose the town project (existing or a new folder) and start the Mayor", usage: "bb madmax init --project <proj-id> | --path <dir> --name <name> [--host <host-id>]" },
      { name: "ledger", summary: "Initialize or inspect the town's Beads ledger", usage: "bb madmax ledger init|status [--json]" },
      { name: "rig", summary: "Manage registered rig projects", usage: "bb madmax rig list|add|remove|clone" },
      { name: "sling", summary: "Sling a work item to a polecat", usage: "bb madmax sling --title \"…\" --mission \"…\" [--rig <project-id>] [--tier <tier>] [--json]" },
      { name: "nudge", summary: "Nudge a managed polecat", usage: "bb madmax nudge <thread-id> --text \"…\" [--steer] [--authorize-edits] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's evidence", usage: "bb madmax inspect <thread-id>" },
      { name: "review", summary: "Start an adversarial review of an idle polecat's work", usage: "bb madmax review <thread-id> [--focus \"…\"] [--mode lite|full] [--json]" },
      { name: "verify", summary: "Gather git evidence from a managed thread's worktree", usage: "bb madmax verify <thread-id>" },
      { name: "land", summary: "Deliver: commit, push the branch, bead to review", usage: "bb madmax land <thread-id>" },
      { name: "buzzard", summary: "Dispatch a Buzzard cruft sweep to a rig", usage: "bb madmax buzzard --rig <project-id> | --git-url <url> [--unmaintained] [--json]" },
      { name: "imperator", summary: "Dispatch an Imperator security patrol to a rig", usage: "bb madmax imperator --rig <project-id> | --git-url <url> [--json]" },
      { name: "adopt", summary: "Adopt an existing thread into the town", usage: "bb madmax adopt --thread <thread-id> [--role mayor|polecat] [--bead <bead-id>] [--json]" },
      { name: "adopt-pr", summary: "Adopt an external pull request for town maintenance", usage: "bb madmax adopt-pr --git-url <url> --pr <n> | --rig <project-id> --pr <n> [--json]" },
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
          const status = await buildStatus();
          const ledgerLines = status.ledger === null
            ? []
            : status.ledger.bdAvailable
              ? status.ledger.initialized
                ? [`Ledger: ${status.ledger.path} — ${status.ledger.open} open · ${status.ledger.inProgress} in progress · ${status.ledger.ready} ready · ${status.ledger.convoys} convoys`]
                : ["Ledger: not initialized — run: bb madmax ledger init"]
              : ["Ledger: bd not installed on this machine — https://github.com/gastownhall/beads"];
          return ok(
            status,
            [
              status.mayor
                ? `Mayor: ${status.mayor.title} (${status.mayor.state}) ${status.mayor.threadId}`
                : status.townProjectId
                  ? `Town: ${status.townProjectId} — no Mayor yet. Run: bb madmax start`
                  : "No town yet. Run: bb madmax init",
              ...status.threads.filter((thread) => thread.role !== "mayor").map((thread) => `${thread.role.padEnd(8)} ${thread.state.padEnd(9)} ${thread.title}  ${thread.threadId}`),
              ...(status.rigs.length ? [`Rigs: ${status.rigs.map((rig) => rig.name).join(", ")}`] : []),
              ...ledgerLines,
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
            const rigs = (allRigs.all() as RigRow[]).map((row) => ({ projectId: row.project_id, name: row.name, forge: row.forge ?? null, registeredAt: row.registered_at }));
            return ok(
              { rigs },
              rigs.length
                ? rigs.map((rig) => `${rig.name.padEnd(20)} ${rig.projectId}${rig.forge ? `  forge=${rig.forge}` : ""}`).join("\n")
                : "No rigs registered.",
            );
          }
          if (sub === "add") {
            const projectId = target ?? args.one("project");
            if (!projectId) return fail("rig add requires <project-id>");
            const rig = await addRig(projectId);
            return ok(rig, `Registered rig “${rig.name}” (${rig.projectId}).`);
          }
          if (sub === "clone") {
            const gitUrl = target ?? args.one("url");
            if (!gitUrl) return fail("rig clone requires <git-url>");
            const parsed = createRigParams.safeParse({ gitUrl, name: args.one("name") });
            if (!parsed.success) return fail(`Invalid rig clone request: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
            const result = await createRig(parsed.data);
            return ok(result, `Rig “${result.name}” cloned and registered (${result.projectId}) at ${result.path}.`);
          }
          if (sub === "forge") {
            const projectId = target ?? args.one("project");
            const value = args.one("forge") ?? args.positional[2];
            if (!projectId || !value) return fail("rig forge requires <project-id> <gh|glab|gt|tea|none|auto>");
            const normalized = value.trim().toLowerCase();
            const pin = FORGE_ALIASES[normalized] ?? normalized;
            if (!["gh", "glab", "gt", "tea", "none", "auto"].includes(pin)) {
              return fail(`Unknown forge “${value}”. Use one of: gh, glab, gt, tea, none, auto (auto infers from the remote).`);
            }
            const row = rigById.get(projectId) as RigRow | undefined;
            if (!row) return fail(`No rig ${projectId}. Register it first: bb madmax rig add ${projectId}`);
            const stored = pin === "auto" ? null : pin;
            db.prepare(`UPDATE rigs SET forge=? WHERE project_id=?`).run(stored, projectId);
            logEvent("rig", `Forge for rig ${row.name} ${stored ? `pinned to ${stored}` : "pin cleared (auto-infer from remote)"}`);
            const effective = await resolveForge(projectId);
            return ok({ rig: projectId, forge: stored, effective }, `Forge for “${row.name}” set to ${stored ?? "auto"} (effective: ${effective.forge ?? "none"} via ${effective.cli ?? "no CLI"}).`);
          }
          if (sub === "remove") {
            const projectId = target ?? args.one("project");
            if (!projectId) return fail("rig remove requires <project-id>");
            const removed = removeRig(projectId);
            return ok({ removed }, removed ? `Removed rig ${projectId}.` : `No rig ${projectId}.`);
          }
          return fail(`Unknown rig subcommand “${sub}”.`);
        }
        if (command === "ledger") {
          const [sub] = args.positional;
          if (sub === "init") {
            const result = await initLedger();
            return ok(result, `Ledger initialized at ${result.path}.`);
          }
          if (sub === "status" || sub === undefined) {
            const ledger = await ledgerBlock();
            if (ledger === null) return fail(await noTownMessage());
            return ok(
              ledger,
              [
                `bd: ${ledger.bdAvailable ? "available" : "NOT installed — https://github.com/gastownhall/beads"}`,
                `Ledger: ${ledger.initialized ? `initialized at ${ledger.path}` : "not initialized — run: bb madmax ledger init"}`,
                ...(ledger.initialized
                  ? [
                      `Open beads: ${ledger.open}`,
                      `In progress: ${ledger.inProgress}`,
                      `Ready: ${ledger.ready}`,
                      `Convoys: ${ledger.convoys}`,
                    ]
                  : []),
              ].join("\n"),
            );
          }
          return fail(`Unknown ledger subcommand “${sub}”.`);
        }
        if (command === "sling") {
          const parsed = slingParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            tier: args.one("tier"), rigProjectId: args.one("rig"), beadId: args.one("bead"),
          });
          if (!parsed.success) return fail(`Invalid sling brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          await ensureMayor();
          const result = await sling(parsed.data, context.threadId);
          return ok(
            result,
            `Slung “${result.title}” to a polecat in ${result.threadId} (tier ${result.tier}${result.beadId ? `, bead ${result.beadId}` : ""}).`,
          );
        }
        if (command === "nudge") {
          const threadId = args.positional[0];
          const text = args.one("text");
          if (!threadId || !text) return fail("nudge requires <thread-id> and --text");
          await nudge(threadId, text, args.bool("steer"), args.bool("authorize-edits"));
          return ok({ threadId }, `Nudged ${threadId}.`);
        }
        if (command === "review") {
          const threadId = args.positional[0];
          if (!threadId) return fail("review requires <thread-id>");
          const mode = args.one("mode");
          if (mode !== undefined && mode !== "lite" && mode !== "full") return fail("--mode must be lite or full");
          const result = await startReview(threadId, reviewSpecFrom({ mode, focus: args.one("focus") }));
          return ok(
            result,
            `${result.created ? "Started" : "Already running"}: ${result.reviewers.map((reviewer) => reviewer.title).join("; ")}`,
          );
        }
        if (command === "verify") {
          const threadId = args.positional[0];
          if (!threadId) return fail("verify requires <thread-id>");
          return ok({ threadId }, await verify(threadId));
        }
        if (command === "land") {
          const threadId = args.positional[0];
          if (!threadId) return fail("land requires <thread-id>");
          return ok({ threadId }, await land(threadId));
        }
        if (command === "adopt") {
          const threadId = args.one("thread");
          if (!threadId) return fail("adopt requires --thread <thread-id>");
          const role = args.one("role");
          if (role !== undefined && role !== "mayor" && role !== "polecat") return fail("--role must be mayor or polecat");
          const result = await adoptThread({ threadId, role, beadId: args.one("bead") });
          return ok(
            result,
            `Adopted ${result.threadId} as ${result.role}${result.beadId ? ` (bead ${result.beadId})` : ""}.`,
          );
        }
        if (command === "adopt-pr") {
          const prNumber = Number(args.one("pr"));
          if (!Number.isInteger(prNumber) || prNumber < 1) return fail("adopt-pr requires --pr <number>");
          const gitUrl = args.one("git-url");
          const rigProjectId = args.one("rig");
          if (!gitUrl && !rigProjectId) return fail("adopt-pr requires --git-url <url> or --rig <project-id>");
          await ensureMayor();
          const result = await adoptPr({ ...(gitUrl ? { gitUrl } : {}), ...(rigProjectId ? { rigProjectId } : {}), prNumber });
          return ok(result, `Adopted PR ${result.pr} for maintenance (bead ${result.beadId}, thread ${result.threadId}).`);
        }
        if (command === "buzzard" || command === "imperator") {
          const rigProjectId = args.one("rig");
          const gitUrl = args.one("git-url");
          if (!rigProjectId && !gitUrl) return fail(`${command} requires --rig <project-id> or --git-url <url>`);
          await ensureMayor();
          const result = await dispatchPatrol(command, {
            ...(rigProjectId ? { rigProjectId } : {}),
            ...(gitUrl ? { gitUrl } : {}),
            ...(command === "buzzard" ? { includeUnmaintained: args.bool("unmaintained") } : {}),
            reason: "demand",
          });
          if (result.skipped) {
            return ok(result, `A patrol is already active for ${result.name}; it will report when done.`);
          }
          return ok(result, `${command === "buzzard" ? "Buzzard" : "Imperator"} dispatched to ${result.projectId} (thread ${result.threadId}).`);
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
