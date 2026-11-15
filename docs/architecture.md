# madmax architecture — Phase 0 spike record

Verified 2026-11-15 against `@get-bb/plugin-sdk` **0.6.132** declarations
(`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, 27.5k
lines) on **bb 0.49.0**. Every load-bearing assumption for the Phase 1 design
below was confirmed against the real declarations, not docs.

## Verified SDK surface

| Capability | Verified | madmax use |
| --- | --- | --- |
| `threads.spawn` with `environment: { type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" \| "named" } } }` | `createThreadRequestSchema` (L12749) | Polecat hooks; bb owns placement, setup, teardown, cleanup — replaces ghostex's pinned `projects/<name>-<suffix>` placement |
| `providerId` / `model` / `reasoningLevel` / `serviceTier` / `permissionMode` (`accept-edits` `auto` `full` `workspace-write`) in the spawn call | same | Model tier chosen **at spawn** — no first-turn re-model race (ghostex flaw fixed) |
| `parentThreadId` + `lifecycleOwnerThreadId` + `parentNotifications: "auto" \| "off" \| "stuck"` | same | bb natively notifies a parent thread when a child is **stuck** — in-band redundancy under our supervisor |
| `pluginMetadata` on threads, writable via threads API, readable (frozen snapshot) in `PluginAgentConfigurationContext` | L12928, L20759 | Stamp `{ role, beadId, rig, tier }` on every spawned thread; role-gate tools off the same stamp |
| Events: `thread.created` `.active` `.idle` (with `lastAssistantText`) `.failed` (with `error`) `.archived` **`.unarchived`** `.deleted`, `interaction.pending` | `PluginEvents` map (L19964+) | Deterministic Deacon triggers — no hourly LLM patrol |
| `threads.send` with `queue-if-active`; `experimental_mode: "steer-if-active"` | L25794, L25896 | Nudges: queue a course answer, steer a polecat off a wrong path mid-turn |
| `threads.output`, `threads.timeline` (two read overloads), prompt history, conversation outline | L19302, L19336 | **Seance**: read any thread's transcript, including archived ones |
| `threads.unarchive` | ThreadUnarchiveResult | Restore a dead polecat with its context intact |
| `threadSections` area (create/list/update) | L19379 | The "Town" sidebar section |
| `bb.agents.registerTool` + `configure(ctx => { tools, skills, instructions })` | L21227–21244 | Mayor gets `town_*` tools + mayor skill; polescat threads get only `polecat_report` + polecat skill |
| `bb.background.service(name, { start(signal) })` | L20527 | The Deacon supervisor loop |
| `bb.realtime.publish` | scaffold server.ts | Town Hall live updates |
| `bb.storage.database()` + migrations, `bb.settings` incl. `type: "project"` | scaffold + Chief | Mapping/outbox store; `townProject` setting |
| App side: `navPanel`, `homepageSection`, thread-row metadata, `ExperimentalBadge`, thread actions menu, pending-interaction surfaces, settings sections | export list (L27501) | Town Hall dashboard + role badges |

## Design refinements from the spike

1. **Stamp + index.** Threads carry role/bead/rig/tier in `pluginMetadata`;
   our SQLite mapping remains the queryable index (metadata list APIs are
   fetch-by-ids, not search). Both stay in sync at spawn time.
2. **Native stuck notifications.** Spawn polecats with the Mayor as
   `parentThreadId` and `parentNotifications: "stuck"`; keep Chief-style
   outbox + supervisor stall detection as the durable layer.
3. **Polecat questions.** `interaction.pending` fires when a polecat uses its
   provider's native question affordance; the Mayor can watch and answer via
   interaction APIs. Primary contract stays `polecat_report`; explore in
   Phase 4.
4. **Base branches.** `managed-worktree` accepts `baseBranch: { kind: "named"
   }` — slings can branch off something other than default when a bead needs
   it.

## Phase 1 blueprint

**Storage** (Chief-compatible, extended):

- `plugin_meta` (key/value) — section id, schema version
- `rigs` (project_id PK, name, registered_at) — registered rig bb projects
- `town_threads` (thread_id PK, role `mayor|polecat|reviewer`, project_id,
  rig_project_id?, mayor_thread_id?, worker_thread_id?, bead_id?, title,
  state, status, result, blocker, recommendation, active_since,
  active_cycle, stall_alerted_cycle, created_at, updated_at) — bead↔thread
  mapping + live-state cache
- `alert_outbox` (dedupe_key PK, target_thread_id, source_thread_id,
  message, delivered_at, attempts, last_error, created_at) — durable alerts
- `town_events` (id, at, kind, message, thread_id, bead_id) — activity feed

**Roles & tools:** Mayor: `town_sling`, `town_nudge`, `town_roster`,
`town_inspect`, `town_convoy`, `town_ready`, `town_verify`, `town_review`,
`town_land`, `town_complete`; Polecat/Reviewer: `polecat_report`.

**CLI:** `bb madmax status | start | init | ledger | rig | sling | nudge |
inspect | review | verify | land`.

**Supervisor:** 30s reconcile (live `threads.get` vs cache, section
refiling, state repair — never treat an SDK error as deletion), stall
detection (`active_since` > `stallMinutes`), claim-lease heartbeats, outbox
retries, mayor revival.

## Resolved items (was: open)

- Town checkout path for `bd -C`: resolved via `projects.get().sources[]`
  (`{ path, hostId, isDefault }`); the ledger requires the town source on the
  bb server's machine.
- Tier settings: five tiers × provider/model/reasoning as plugin settings,
  `difficult` by default; Mayor and Reviewer have their own settings.
- Polecat `permissionMode`: settled with the owner — `accept-edits` default;
  anything outside a worktree flows polecat → Mayor → owner.
- bd `review` status: not built-in (open, in_progress, blocked, deferred,
  closed, pinned, hooked) — town ledger init registers it via
  `bd config set status.custom review`.

## Remaining known limits

- Reviewer read-only-ness is prompt-level (bb has no read-only permission
  mode); repairs require the Mayor's explicit `authorizeEdits` nudge.
- Verify/land shell out to `git` in the worktree path, so the worktree must
  live on the bb server's machine (single-host towns today).
- `hosts.pickFolder` (native OS folder dialog) needs a `clientHostId` the
  plugin app has no documented way to learn, so onboarding uses the in-app
  `hosts.directory` browser instead.
