---
name: ship-pr
description: Use when a change in this project is implemented, reviewed and verified and needs to reach main; covers pushing the branch, opening the pull request, linking and watching it in t3, merging once CI passes, and what to do when CI fails.
---

# Ship a change through a pull request

Nothing reaches `main` except through a pull request whose CI passed (`.github/workflows/ci.yml`: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`). Never push to `main` and never force-push a branch that has a PR.

## Before the PR

1. Bring in `main`: `git -C <wt> fetch origin` and `git -C <wt> merge origin/main`. On a conflict, stop and report it; do not resolve someone else's change by guessing.
2. Run `pnpm check` and `pnpm build` again in the stack after the merge.
3. Commit messages are English, explain why, and end with the attribution line the session gives (for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Open it

1. `git -C <wt> push -u origin <branch>`.
2. `gh pr create --base main --head <branch> --title "<what changed>" --body "<body>"`. The body says what changed and why, how it was verified (numbers, k of n, screenshot paths), what is still unverified, and ends with the session's PR attribution line.
3. Link it to your thread at once with t3's `link_pull_request` (full URL), then `watch_pull_request` and end the turn. Do not sleep, loop, or run `gh pr checks --watch`: t3 wakes the thread when checks pass or fail.

## When it wakes you

- **Checks passed**: confirm with `gh pr view <n> --json statusCheckRollup,mergeable`, then `gh pr merge <n> --merge --delete-branch`. The local branch stays while a worktree uses it; that is expected.
- **Checks failed**: read the failing step with `gh run view <run> --log-failed`, fix it in the same branch, push again. Common failures so far: `oxfmt --check` on Markdown (tables it realigns, double blank lines), and `actions/setup-node` with `packageManager` set (needs `package-manager-cache: false`, pnpm comes from corepack).
- **Review comments**: answer or fix them before merging.

## After the merge

- `unwatch_pull_request`; t3 settles the thread on merge.
- Report the PR URL, the merge commit SHA and the CI run to the supervisor (`run-delegated-task`). The supervisor updates the main checkout with `git -C <main> pull --ff-only origin main`.
