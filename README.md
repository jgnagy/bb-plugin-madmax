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
- The ghostex "madmax" town skill — the operational conventions (brief
  template, model tiers, verify-and-land ritual, the never-commit-to-main law)
  this plugin ports to bb.

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

Phase 0 — scaffold. The current code is the `bb plugin new` example (a todo
list) kept as a live reference for the RPC/CLI/skill/realtime surfaces; it will
be replaced by the town supervisor.

Roadmap:

- [ ] Phase 1 — core: roles, section, spawn/sling across rigs, outbox, supervisor
- [ ] Phase 2 — Beads layer: `bd` shell-out, convoys, skills (mayor, polecat)
- [ ] Phase 3 — Town Hall UI: problems view, convoy board, roster, feed
- [ ] Phase 4 — refinery: verify, deliver, reviewer threads, landing flow

## Develop

```
npm install
bb plugin build        # write dist/
bb plugin install .    # install into bb
bb plugin dev          # rebuild + reload on save
npx tsc --noEmit       # typecheck
bb plugin types --check
```

Requires `bd` 1.0+ on PATH for the ledger (Phase 2+). The full plugin API is
on disk after `npm install` at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

## License

MIT
