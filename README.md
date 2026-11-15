# madmax

A Gas Town for [bb](https://github.com/get-bb/bb): a bb plugin that runs a
multi-agent software factory on top of the [Beads](https://github.com/gastownhall/beads)
ledger.

One **Mayor** thread coordinates work across every project you register as a
**rig**. It breaks goals into beads (convoys are epics), slings each bead to a
**polecat** worker thread running in its own bb-managed worktree, patrols
thread health deterministically, verifies finished work (with a read-only
reviewer), and delivers it — branch pushed, bead to review — while the owner
decides what merges. Work state lives in Beads, so it survives session loss,
plugin reloads, and bb itself.

## Lineage

- [Gas Town](https://github.com/gastownhall/gastown) (MIT, retired) — the
  concepts: town, mayor, rig, polecat, hook, convoy, bead, refinery, GUPP/MEOW/NDI.
- [Beads / `bd`](https://github.com/gastownhall/beads) — the durable ledger
  this plugin is built on. Required on the bb server machine.
- [Chief for bb](https://github.com/divyesh-puri/bb-plugin-chief) (MIT) — the
  proven bb plugin patterns: role-gated agent tools, visible worker threads in
  a sidebar section, managed-worktree spawning, a deterministic supervisor with
  a durable alert outbox, and reconciliation that trusts live thread state.
- Earlier Gas Town emulations on other agent harnesses — the operational
  conventions (brief template, model tiers, verify-and-land ritual, the
  never-commit-to-main law) this plugin carries forward.

## Architecture

| Gas Town concept | madmax mechanism |
| --- | --- |
| Town | A bb project holding the `.beads` ledger and `town.md` rules |
| Mayor | One visible thread in the town project, granted `town_*` orchestration tools |
| Rig | Any bb project registered with the plugin |
| Polecat | A worker thread in a rig project, spawned in a bb-managed worktree |
| Hook | bb's managed worktree (setup/teardown/cleanup owned by bb) |
| Bead / Convoy | `bd` work items and epics in the town ledger; plugin maps bead ↔ thread |
| Sling / Nudge | `town_sling` / `town_nudge` tools → `threads.spawn` / `threads.send` |
| Report | `polecat_report` (ready/blocked) → durable outbox → Mayor thread |
| Deacon (patrol) | Background supervisor service on thread events + stall detection |
| Witness | Read-only reviewer thread spawned in the worker's worktree |
| Refinery | Mayor verification → branch push → bead to review → owner decides |
| Seance | Durable bb threads reopen with context; reports persist as bead comments |
| Feed | Town Hall dashboard page: problems-first roster, convoy board, activity |

The plugin never keeps a parallel work ledger: Beads is the single source of
truth. Plugin storage holds only the bead↔thread mapping, rig registry, and
the alert outbox.

## Status

Phase 4 — the refinery. The Mayor drives finished work through delivery:
`town_verify` gathers deterministic git evidence from the polecat's worktree
(status, diff, log), `town_review` commissions an independent read-only
reviewer thread in that same worktree (verdicts recorded on the bead;
repair passes only with explicit authorization), and `town_land` commits any
uncommitted work, pushes the branch to the rig's origin, and moves the bead
to a `review` status in the ledger — the owner alone decides the merge path.
Town ledgers register the `review` status at init.

With Phase 3's Town Hall page (problems-first board, roster, activity feed)
and Phase 2's Beads ledger underneath, the four planned phases are complete:
madmax is a full Gas Town for bb.

Rigs are conversational, too: tell the Mayor "I'd like to make a PR for
<github repo> to fix <issue>" and it can bring the repo in itself —
`town_create_rig` clones the repo into the town's `rigs/` directory
(quietly excluded from the town repo's status) and registers it as a rig;
the Mayor reads the issue with `gh` in its shell, slings a bead tagged with
the rig, and lands the branch when the work verifies. Opening the PR is
owner-approved at dispatch and travels in the polecat's brief (`openPr:
true`).

Reviews are adversarial and structured. `town_review` commissions deep
reviews of a polecat's work before it lands: lite mode (one reviewer) or
full mode (one reviewer per criterion — security, maintainability,
performance, quality, or your own), each working as a persona you name.
Every review runs three phases — findings with HIGH/MEDIUM/LOW confidence,
verification of the HIGH findings, then a compiled ship/fix verdict — and
the Mayor drives the fix loop until the verdict is clean. `town_pr_review`
reviews *someone else's* pull request the same way: it finds or creates
the rig, mints a dedicated bead, and spawns reviewer threads that check
out the PR; the Mayor compiles findings and drafts the PR response
(approve, comment, request changes) — the owner decides whether to post.

Briefs are written for simpler models: short sentences, one idea per
line, no jargon — the town vocabulary lives with the Mayor, not in the
briefs. And models are layered the Gas Town way: the Mayor runs its own
provider/model, five polecat tiers each carry theirs, and reviewers and
patrol roles have separate settings.

Quick start — the town asks where it should live the first time you start it.
On bb's New Thread screen, the Madmax section offers importing an existing
project or creating a dedicated folder (recommended); or from the CLI:

```
bb madmax init --project <proj-id>        # import an existing town project
bb madmax init --path <dir> --name <name>  # create a dedicated town folder
bb madmax rig add <proj-id>               # register a rig
bb madmax ledger status                   # ledger health and bead counts
```

(`bb madmax start` with no town configured prints the same choices; the town
project can also be set directly with `bb plugin config madmax set
townProject <proj-id>`, and moving an established town requires that command.
`bd` 1.0+ must be on the bb server machine's PATH for the ledger.)

Roadmap:

- [x] Phase 1 — core: roles, section, spawn/sling across rigs, outbox, supervisor
- [x] Phase 2 — Beads layer: `bd` shell-out, convoys, bead↔thread linkage
- [x] Phase 3 — Town Hall UI: problems view, convoy board, roster, feed
- [x] Phase 4 — refinery: verify, deliver, reviewer threads, landing flow

Later, if the town wants them: molecules/formulas (`bd cook`), scheduler
capacity (compose with bb's concurrency-limit), and Wasteland federation
via `bd dolt` remotes.

## Develop

```
npm install
npm test                # vitest against the fake plugin host
npx tsc --noEmit        # typecheck
bb plugin build         # write dist/
bb plugin install . --yes
bb plugin dev           # rebuild + reload on save
bb plugin types --check
```

Requires `bd` 1.0+ on PATH for the ledger (Phase 2+). The full plugin API is
on disk after `npm install` at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

## License

MIT
