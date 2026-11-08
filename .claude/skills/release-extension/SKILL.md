---
name: release-extension
description: Use when publishing a new downloadable version of the extension (a GitHub release with the zip users load unpacked); covers the version bump, the tag, what the release workflow checks, and how to verify the published zip.
---

# Release a new version

Users install the extension from the zip attached to a GitHub release (README, "安裝"). `.github/workflows/release.yml` builds it when a `v*` tag is pushed.

## Steps

1. The change is merged into `main` through a PR (`ship-pr`) and `main`'s CI passed.
2. Bump `version` in both `public/manifest.json` and `package.json` (same value, `MAJOR.MINOR.PATCH`), in a PR of its own or the last PR before the release.
3. After it merges: `git -C <main> pull --ff-only origin main`, then `git -C <main> tag v<version>` and `git -C <main> push origin v<version>`. Pushing a tag publishes a public release: do it only with the user's OK.
4. The workflow checks that the tag equals the manifest version, runs `pnpm check` and `pnpm build`, zips `dist/` as `yt-ai-subs-v<version>.zip`, and creates the release with generated notes.

## Verify

- `gh run list --workflow release.yml --limit 1` and `gh run view <id>`: every step succeeded.
- `gh release view v<version> --json url,assets` shows the zip.
- Download it into a scratch folder (`gh release download v<version>`) and `unzip -l`: `manifest.json` is at the top level (Chrome loads that folder), with `background.js`, `content.js`, `page.js`, `popup.html` and `assets/`. Nothing from `test/` or `.qa/`.
- Load the unzipped folder in agent-browser (`test-extension-in-browser`) and check that the AI track appears on a YouTube video.

## When the workflow fails

- Fix the cause in a PR. If the release was **not** created yet, the tag may be moved to the fixed commit (`git tag -f` and `git push -f origin v<version>`); once a release exists, never move its tag: bump to the next patch version instead.
- Known failures: `setup-node` with `packageManager` set needs `package-manager-cache: false`; `oxfmt --check` fails on Markdown tables it realigns or on double blank lines.
