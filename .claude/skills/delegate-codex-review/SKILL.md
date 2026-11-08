---
name: delegate-codex-review
description: Use for step 3 of this project's workflow, when your diff is ready for review; says how to hand it to Codex gpt-6.1-sol at medium effort with t3's delegate_task, what the review brief must contain, and how to act on the findings.
---

# Delegate the review to Codex

`AGENTS.md` step 3: the diff is reviewed by Codex `gpt-6.1-sol` at medium reasoning effort, in your own worktree, reporting findings only. The reviewer must not be anchored on your conclusions: give it the diff and the intent, not your verdict.

## Start it

1. Call `orchestrator_capabilities` once per thread (before the first `delegate_task`) to get the Codex provider and the exact option id for reasoning effort.
2. `delegate_task` with:
   - `role: "review"`, `isolation: "shared"` (same worktree, so it sees your uncommitted changes), `mode: "async"`;
   - `target`: the Codex provider, `model: "gpt-6.1-sol"`, the reasoning-effort option set to `medium`;
   - a `title` like "Review <branch> diff" and a `clientRequestId`.
3. End the turn or keep working on something the review does not touch; t3 tells you when it reports. Do not poll with `task_status` or sleep.

## The review brief

- What the change is for, in two or three sentences, and the files it touches.
- How to see it: `git diff main...HEAD` plus `git status` / `git diff` for uncommitted work, in the worktree path you give.
- What to look for: correctness and regressions first (seek and cancel paths, rate limiter and quota, cache races between tabs, the CC-menu hook's fallback), then missing tests, then smaller issues.
- Rules: report findings only, do not edit files, do not run Groq or open a browser; rank each finding Blocker / P2 / P3 with file, line and a concrete failure scenario.
- Ask it to follow the `review-change` skill.

## Act on it

- Fix every Blocker and P2 yourself (do not start another delegate for small fixes); fix or explain each P3.
- Re-run the review only after a large change.
- Settle the review's child thread with `t3_thread_organize` (`action: "settle"`) once it has reported, and list its findings and what you did about each in your report and PR body.
