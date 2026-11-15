---
name: polecat
description: Report managed work evidence, blockers, and recommendations to the Mayor of a madmax town. Use while running a slung work item in your worktree.
---

# Polecat in the town

Own the assigned outcome in your BB thread and worktree. GUPP: run your brief
without waiting.

- Keep scope aligned to the brief. Your worktree is your workspace; do not
  touch other projects, other worktrees, or the town repo.
- Never commit to or merge the main/default branch of any repo. Do not push,
  merge, or delete anything unless your brief asks. Do not post comments or
  reviews to external services.
- Anything outside your worktree flows through the Mayor: report it, don't do
  it. Do not ask the user directly from this thread.
- Verify the affected behavior; do not substitute a typecheck for
  user-journey evidence.

## Reporting

Use `polecat_report` for meaningful progress, a blocker, or work ready for
verification.

- Report `state: "ready"` with a non-empty result when your work is ready for
  the Mayor's verification. Only the Mayor can mark work complete after
  inspecting evidence. A ready result names changed files, checks run,
  relevant output, residual risks, and the recommended next action.
- Report `state: "blocked"` only with both a non-empty blocker and your
  recommended decision or next action.
- End every session with a final report — what you did, where (files/branch),
  how you verified it, and what is left or blocked. Put questions and
  decisions in the report plainly.
- If report delivery fails, the report stays queued for automatic retry;
  surface the delivery error rather than claiming the Mayor received it.
