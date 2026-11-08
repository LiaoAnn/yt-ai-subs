---
name: run-delegated-task
description: Use when a supervisor thread launched you to do one task in this project (as a worker in a worktree or as a read-only researcher); covers how to start, which approvals you have, when to stop and ask, and what your report must contain.
---

# Run a task a supervisor delegated to you

You were started by the supervisor thread named in your brief. Do the work yourself; start no other threads except the Codex review that `AGENTS.md` requires.

## Start

1. Read `~/.config/devvm/AGENTS.md`, `~/.config/devvm/projects/yt-ai-subs/README.md` and the repo's `AGENTS.md` (a researcher in a scratch folder reads the repo's copy at `/data/code/yt-ai-subs/AGENTS.md` only if the brief says so).
2. Run `wt-status` with no argument to learn your worktree path, then pass that path to every `wt-*` command and to `git -C`.
3. Reread the brief's "done" checks; they are what your report must prove.

## Approvals

- External services (Groq, any paid API, any site other than YouTube): only what the brief approves, within its budget. Check the remaining daily budget before the first call; stop at a 429 or when the brief's floor is reached, and report.
- The Groq key: only through the `test-extension-in-browser` procedure; never read, print or log its value.
- Other worktrees: only those the brief names, and only in the way it says (for example "copy `.qa/` read-only").
- Never sign in to YouTube or Google. Never push to `main`, force-push, or run `wt-down` unless the brief says the user allowed it.

## While working

- Workers follow the five steps in `AGENTS.md`: plan, implement, Codex review, browser verification, then a PR that merges when CI passes.
- Claim a cause only with a check that could have refuted it; count claims (k of n). Mark everything else as a guess.
- Long runs go to `wt-bg … --script <file>` with `wt-wait`; nothing that needs a manual approval.
- Stuck for more than 20 minutes, or need a decision only the user can make: send the question to the supervisor with `t3_thread_send` and keep doing what does not depend on the answer.

## Report

Send one message to the supervisor with `t3_thread_send`. It holds:

- **Result**: what was found or changed, against each "done" check in the brief.
- **Evidence**: commands and output, numbers with their counts, screenshot paths (full absolute paths).
- **Changes**: branch, commits, PR URL and merge SHA, CI result (workers).
- **Cost**: Groq requests and tokens used, and the budget Groq reported last.
- **Unverified and risks**: what you did not check, what is inferred, what might break next.
- **Left running**: browser sessions, `wt-bg` jobs, tmux sessions (close them first if the task is over).

Then: a worker's thread settles itself when its PR merges (call `unwatch_pull_request` first); a researcher closes its agent-browser session and settles its own thread with `t3_thread_organize` (`action: "settle"`). Settle the Codex review child thread you started once it has reported.
