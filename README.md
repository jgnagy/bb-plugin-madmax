# madmax

A Gas Town for [bb](https://github.com/get-bb/bb): a bb plugin that runs a
multi-agent software factory on top of the [Beads](https://github.com/gastownhall/beads)
ledger.

One **Mayor** thread coordinates work across every project you register as a
**rig**. It breaks goals into beads (convoys are epics), slings each bead to a
**polecat** worker thread running in its own bb-managed worktree, patrols
thread health deterministically, verifies finished work, and delivers it —
branch pushed, bead to review — while you decide what merges. Work state
lives in Beads, so it survives session loss, plugin reloads, and bb itself.

## Features

**One Mayor, many rigs.** The Mayor is an ordinary visible bb thread in the
town project. Rigs are any bb projects you register — including repos the
Mayor clones itself when you name one it doesn't know. Polecats are ordinary
visible threads too: watch them live, read their transcripts, or take over
mid-turn.

**A real work ledger.** Convoys are epics, beads are the work items, rig
names are labels that route slings. Beads are claimed at sling time and
closed at verified completion, every polecat report lands on its bead as a
comment, and claim leases are kept alive by the patrol while work runs.
`bd` is the single source of truth — the plugin never keeps a parallel
ledger, and your own `bd` commands interoperate with the town's.

**Conversational rig onboarding.** "I'd like to make a PR for \<github
repo\> to fix \<issue\>" works end to end: the Mayor clones the repo into
the town's `rigs/` directory, reads the issue with `gh`, slings a bead
tagged with the rig, and delivers the branch when the work verifies.
Opening the PR is owner-approved at dispatch and travels in the polecat's
brief.

**Adversarial reviews before landing.** Lite mode (one reviewer) or full
mode (one reviewer per criterion — security, maintainability, performance,
quality, or your own), each working as a persona you name. Every review
runs three phases — findings with HIGH/MEDIUM/LOW confidence, verification
of the HIGH findings, then a ship/fix verdict — and the Mayor drives the
fix loop until the verdict is clean.

**PR review as a task.** Point the Mayor at someone else's pull request:
it finds or creates the rig, mints a dedicated bead, and spawns reviewer
threads that check out the PR. The Mayor compiles the findings and drafts
the PR response — approve, comment, or request changes — and you decide
whether to post it.

**Patrol roles on cron or demand.** The **Buzzard** circles a repo for
pointless tests, obvious comments, dead code, abandoned PRs, and unused
dependencies (optionally unmaintained ones), reporting to the Mayor with an
optional *draft* cleanup PR — a draft goes ready only after you or the
Mayor approve it. The **Imperator** patrols for security problems and
reports **only** to the Mayor: never issues, never PRs, never public posts.

**The refinery.** `town_verify` gathers deterministic git evidence from the
worktree (status, diff, log) before anyone trusts a report; `town_land`
commits uncommitted work, pushes the branch to the rig's origin, and moves
the bead to review. Merges, PRs to default branches, and anything
irreversible stay yours.

**Town Hall.** A sidebar page with the town problems-first: blocked and
failed threads under "Needs attention", and a task board that mirrors the
pipeline — every bead from every convoy in Blocked / Ready / In flight /
In review / Landed columns, or grouped by convoy, each card showing its
labels and linked polecat. A live roster and an activity feed sit
underneath, all updating in real time. The board is read-only by design:
stages are earned through the Mayor's tools, never by dragging.

**A deterministic Deacon.** A background supervisor watches thread
lifecycle events, repairs state from live data, detects stalls, keeps claim
leases alive, and delivers alerts to the Mayor through a durable outbox
with retries. No schedulers to babysit.

**Briefs written for smaller models.** Polecat briefs are short sentences,
one idea per line, zero jargon — and models are layered: the Mayor, five
polecat tiers, reviewers, and patrol roles each have their own
provider/model/reasoning settings. Orchestrate with a strong model; sling
well-defined tasks to cheaper ones.

**Adoption.** Nothing that predates the town is stranded: `town_adopt`
brings an existing bb thread under management as a polecat (optionally
claiming a ledger bead) or installs an existing thread as the new Mayor —
the old Mayor retires and its polecats re-point automatically. And
`town_adopt_pr` adopts a pull request created outside the town: it finds
or creates the rig, mints a dedicated bead, and spawns a maintainer that
keeps CI green and addresses review feedback — pushing fixes to the PR
branch, while comments, approvals, and the merge stay owner-approved.

**Clean artifacts.** Town vocabulary stays in the town. Commits, PRs, and
comments in your repositories read like normal engineering work — no
beads, polecats, or Mayors in them.

## How it works

| Concept | Mechanism |
| --- | --- |
| Town | A bb project holding the `.beads` ledger and `town.md` rules |
| Mayor | One visible thread in the town project, granted `town_*` tools |
| Rig | Any bb project registered with the plugin (cloned on request) |
| Polecat | A worker thread in a rig project, in a bb-managed worktree |
| Bead / Convoy | `bd` work items and epics in the town ledger; plugin maps bead ↔ thread |
| Sling / Nudge | `town_sling` / `town_nudge` → `threads.spawn` / `threads.send` |
| Report | `polecat_report` (ready/blocked) → durable outbox → Mayor thread |
| Deacon | Background supervisor: reconcile, stall detection, lease heartbeats |
| Refinery | `town_verify` → `town_review` → `town_land` → `town_complete` |
| Town Hall | Dashboard page: problems, convoy board, roster, activity feed |

Polecats run `accept-edits` by default: they can edit freely inside their
own worktree, and everything beyond it — pushes, merges, external services,
PRs — flows polecat → Mayor → you.

## Install

```
bb plugin install git:https://github.com/jgnagy/bb-plugin-madmax.git@semver:^0.2.0
```

Install [Beads](https://github.com/gastownhall/beads) (`bd` 1.0+) on the
machine running the bb server and put it on `PATH` — it is the ledger.
`git` and `gh` (authenticated) are used for cloning, verification, delivery,
and pull requests.

## Using the town

**First run**, the town asks where it should live. On bb's New Thread
screen, the Madmax section offers importing an existing project or creating
a dedicated folder (recommended — it gets a git repo, a Beads ledger, and a
rules starter). From the CLI:

```
bb madmax init --project <proj-id>          # import an existing town project
bb madmax init --path <dir> --name <name>   # create a dedicated town folder
bb madmax rig add <proj-id>                 # register an existing project as a rig
```

**Then talk to the Mayor** like any other thread:

- "I'd like to make a PR for `github.com/org/repo` fixing issue #123."
- "Kick off a PR review of \<link\> and let me know your findings."
- "Run a cruft sweep on authify — and flag unmaintained dependencies."
- "Do a security patrol on bullion and tell me what you find."

The Mayor plans convoys, slings beads, dispatches reviewers and patrols,
and brings you only genuine decisions. Edit `town.md` in the town project
to change the town's operating rules at any time — the Mayor re-reads them
on every patrol cycle.

**CLI reference:**

```
bb madmax status | start | init
bb madmax ledger init | status
bb madmax rig list | add | remove | clone
bb madmax sling --bead <id> | --title "…" --mission "…"
bb madmax nudge | inspect | review | verify | land <thread-id>
bb madmax buzzard | imperator --rig <proj-id> | --git-url <url>
```

Add `--json` to any command when the output drives code; `bb madmax help`
prints everything.

**Settings** (in bb's plugin settings or `bb plugin config madmax set …`):

| Setting | Purpose |
| --- | --- |
| `townProject` | The town's bb project |
| `simplest`…`mostDifficult` (×3 each) | Provider/model/reasoning per polecat tier |
| `mayor` / `reviewer` / `buzzard` / `imperator` (×3 each) | Provider/model/reasoning per role |
| `polecatPermissionMode` | Polecat permissions (`accept-edits` default) |
| `stallMinutes` | How long an active thread runs before the Mayor is alerted |
| `rigsDir` | Where cloned rigs live (empty = `<town>/rigs`) |
| `buzzardCron` / `imperatorCron` | Scheduled patrol crons (empty = off; reload the plugin after changing) |
| `buzzardUnmaintained` | Buzzard also flags unmaintained dependencies |

## Developing

```
npm install
npm test                # vitest against the fake plugin host (runs real bd)
npx tsc --noEmit        # typecheck
bb plugin build         # write dist/
bb plugin install . --yes
bb plugin dev           # rebuild + reload on save
```

CI runs the typecheck and the full suite (with `bd` installed) on every
push. The plugin API ships on disk after `npm install` at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

**Releases are git tags.** bb's git installer resolves `@semver:` ranges
against `vX.Y.Z` tags — `package.json`'s version alone is not enough. To
cut a release: bump `version` in `package.json`, commit, then
`git tag -a vX.Y.Z -m "…"` and `git push origin vX.Y.Z`.

## Lineage

- [Gas Town](https://github.com/gastownhall/gastown) (MIT, retired) — the
  concepts: town, mayor, rig, polecat, convoy, bead, refinery, GUPP/MEOW/NDI.
- [Beads / `bd`](https://github.com/gastownhall/beads) — the durable ledger.
- [Chief for bb](https://github.com/divyesh-puri/bb-plugin-chief) (MIT) —
  proven bb plugin patterns this plugin builds on.

## License

MIT
