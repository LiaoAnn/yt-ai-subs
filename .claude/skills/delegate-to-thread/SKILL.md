---
name: delegate-to-thread
description: Use when you supervise this project and hand a task to a new t3 thread (a worker that changes code, or a researcher that only reads); says what the brief must contain, what not to repeat, how the thread reports back, and how to follow up without blocking.
---

# Delegate a task to a t3 thread

The supervisor thread plans, dispatches, checks reports and talks to the user. Workers change code in their own worktree; researchers only read and measure. Each brief is the only context the thread gets, so it must be complete about the task and silent about what the thread already loads.

## Pick the kind of thread

- **Worker** (changes code): `t3_thread_launch` with `workspaceStrategy: {type: "worktree", baseRef: "main", branch: "<slug>", startFromOrigin: false}`. It follows the `run-delegated-task` skill and the five-step workflow in `AGENTS.md`, ending in a merged PR.
- **Researcher** (reads, measures, changes nothing): `t3_thread_launch` with `scratch: true`. No worktree, no stack, no repo edits. For YouTube caption surveys it follows the `research-youtube-captions` skill.
- Give every launch a `clientRequestId`, so a retry after a lost reply does not start a second thread.

## What the brief contains

1. **Goal**, in the user's terms: the symptom or question, with the video ID, timestamps, or the user's own words.
2. **What is already known**: evidence so far, hypotheses ruled out, earlier reports to build on (thread IDs to `t3_thread_read`). Say which parts are measured and which are only guesses.
3. **Scope and done**: what to change or measure, what is out of scope, and the checks that prove it is done (for example "from the start and after a seek to 0:40, captions show from 0:40 to 1:10; the six old captures lose 0 talk lines").
4. **External calls**: whether the user approved Groq (or another service) for this task, and the budget (for example "Whisper at most 40 requests, translation at most 40K tokens; stop at a 429 or when any daily budget is under 30%"). Without an approval in the brief, the thread calls nothing.
5. **Data rules that are specific to the task**: for example which other worktree's `.qa/` it may copy, only when the user named it.
6. **Report**: the supervisor thread ID to send the report to with `t3_thread_send`, and what the report must hold (see `run-delegated-task`).

Start the brief with "Reply in Traditional Chinese (Taiwan)" when the user reads Chinese.

## What the brief leaves out

- VM rules (`wt-*`, `wt-exec`, no `bash -lc` strings, git only as `git -C <path>`, read-only docker on the VM, no sudo): every agent loads them from `~/.config/devvm/AGENTS.md`.
- The project's workflow, stack, secrets rules: `AGENTS.md`.
- Browser flags, the Groq key procedure, dry runs, captures: `test-extension-in-browser`.
- Point to these by name when the task leans on them; do not paste them.

## Follow up

- Do not block on a thread (`t3_thread_wait`, sleeps, loops). End the turn; the thread's `t3_thread_send` report wakes the supervisor.
- Delegated threads send every question to the supervisor instead of prompting the user (`run-delegated-task`). Answer from what you already know when you can (earlier decisions, where things are, approvals already given); ask the user only what only they can decide (reading another worktree, more budget, a product choice, a secret not yet supplied). Then answer the thread with `t3_thread_send` (`mode: "auto"`, a new `clientRequestId`). When a question shows the repo is missing something every thread needs (like where the test key lives), add it to `AGENTS.md` or a skill too.
- If a delegated thread prompts the user directly anyway, tell the user to decline it, answer the thread yourself, and remind it of the rule.
- Read the report critically before relaying it: check numbers against each other, and look at the diff or the git log yourself (`git -C <main> log main..<branch>`). Relay to the user what changed, the evidence, what is still unverified, and the decisions they need to make.
- A worker's thread settles itself when its PR merges; a researcher settles itself after reporting. Settle any thread left over with `t3_thread_organize` (`action: "settle"`), including the Codex review child threads; settling stops the worktree's stack and keeps its data.
- After a worker's PR merges, update the main checkout: `git -C <main> pull --ff-only origin main`.
