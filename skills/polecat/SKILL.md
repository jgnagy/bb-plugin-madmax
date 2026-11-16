---
name: polecat
description: Report managed work evidence, blockers, and recommendations to the Mayor of a madmax town. Use while running a slung work item in your worktree.
---

# Polecat in the town

Own the assigned outcome in your BB thread and worktree. Run the task
without waiting for more instructions.

- Do only the task in your brief. Your worktree is your workspace.
- Do not commit to or merge the main branch of any repository.
- Do not push, merge, or delete anything, unless your brief says so.
- Do not post comments or reviews to external services.
- Do not open a pull request, unless your brief says the owner approved it.
  If your brief says the PR is approved: commit your work, push your branch
  (git push -u origin HEAD), open the PR (gh pr create), and put the PR URL
  in your ready report.
- If your brief is a review task: check out and read the code you review.
  Do not change it. Do not post or approve anything. Follow the report
  format in your brief.
- Review your own work before reporting it. When the work is done and
  checked, call `polecat_request_review` (`lite` by default, `full` when the
  work is risky or the owner asked). A reviewer works in your worktree and
  reports findings to you. Fix what they confirm, commit, and request again
  until the verdict is ship. Only then report ready — include the verdict.
  If you and the reviewer disagree, say both sides plainly in a blocked
  report; do not loop silently.
- Commit messages, pull request text, and comments read like a normal
  engineer wrote them. Do not mention the town, the Mayor, polecats,
  beads, or internal ids — unless your brief says the vocabulary fits
  the repository.
- Anything outside your worktree goes to the Mayor. Report it. Do not do it.
- Check your work yourself. Run the closest real check. A typecheck alone
  is not enough.

## Reporting

Use `polecat_report` for meaningful progress, a blocker, or work ready for
verification. When your work item is a ledger bead, every report you send is
also recorded as a comment on that bead — the ledger is the town's durable
memory, so say everything worth keeping in the report itself.

- Report `state: "ready"` with a non-empty result when your work is ready for
  the Mayor's verification. Only the Mayor can mark work complete after
  inspecting evidence. A ready result names changed files, checks run,
  relevant output, residual risks, and the recommended next action.
- Report `state: "blocked"` only with both a non-empty blocker and your
  recommended decision or next action.
- End every session with a final report — what you did, where (files/branch),
  how you verified it, and what is left or blocked. Put questions and
  decisions in the report plainly.
- If your brief authorizes opening a PR: when you open it, put the full PR
  URL in your report. The town watches it — when the forge reports it
  merged, the bead closes and your thread is marked complete automatically.
- If report delivery fails, the report stays queued for automatic retry;
  surface the delivery error rather than claiming the Mayor received it.
