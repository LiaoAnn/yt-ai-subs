---
name: test-extension-in-browser
description: Use when you need to build the extension and load it in a real Chrome (agent-browser) to check that it works on a YouTube page or that the popup saves settings.
---

# Build and test the extension in agent-browser

The extension is loaded unpacked from `dist/` of your worktree. Builds run in the dev container; the browser runs on the host (the desktop VM) and reads `dist/` straight from the worktree path.

`<path>` below is your worktree (the git top level). Never sign in to YouTube or Google, and never call Groq or any paid API without the user's OK.

## 1. Build

```bash
T3CODE_WORKTREE_PATH=<path> wt-exec pnpm check
T3CODE_WORKTREE_PATH=<path> wt-exec pnpm build
```

`dist/` must contain `manifest.json`, `popup.html`, `background.js`, `content.js`, `page.js` and `assets/`. For iterative work, run `pnpm dev` (watch) in a tmux session instead, and reload the extension after each rebuild.

## 2. Open YouTube with the extension

Use your own agent-browser session (stable per worktree):

```bash
S=$(agent-browser session id --scope worktree --prefix task)
agent-browser --session $S --extension <path>/dist --args "--no-sandbox" open "https://www.youtube.com/watch?v=jNQXAC9IVRw"
agent-browser --session $S wait --load load
agent-browser --session $S console | grep yt-ai-subs
```

- `--extension` and `--args` apply only when the session's browser starts. If the session is already running (without the extension, or with an old build), `agent-browser --session $S close` first.
- `--no-sandbox` is required on the dev VM: Chrome dies with `No usable sandbox!` because Ubuntu's AppArmor blocks unprivileged user namespaces.
- Add `--headed` only when someone needs to watch on the shared desktop; headless works for everything below.
- Extensions do not run in incognito; agent-browser's default profile is fine.

Expected console lines (all entries log with the `[yt-ai-subs]` prefix):

```
[log] [yt-ai-subs] page script loaded (MAIN world) loading
[log] [yt-ai-subs] content script loaded (isolated world) loading
[log] [yt-ai-subs] content script got page message: page-ready
[log] [yt-ai-subs] background replied: {type: "pong", version: "0.1.0"}
```

`loading` is `document.readyState`: it proves the scripts ran at `document_start`. The last two lines prove page → content (`window.postMessage`) and content → background (`chrome.runtime.sendMessage`) messaging.

## 3. Open the popup

agent-browser cannot click the toolbar icon, so open the popup page as a tab. Find the extension ID first:

```bash
agent-browser --session $S open chrome://extensions
agent-browser --session $S eval "document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelector('extensions-item').id"
agent-browser --session $S open chrome-extension://<id>/popup.html
agent-browser --session $S set viewport 360 480
agent-browser --session $S snapshot -i
```

To test saving, use a fake key (e.g. `gsk_fake_not_a_real_key`), never a real one:

- After choosing an option in a shadcn/Radix `Select`, `wait 800` before the next click: while the dropdown closes, an overlay swallows clicks ("Element is covered by …").
- Save, `wait --text "已儲存"`, `reload`, and snapshot again: the fields should keep their values.
- Read what was stored without printing the key:

```bash
agent-browser --session $S eval "chrome.storage.local.get('settings').then(s => ({...s.settings, groqApiKey: s.settings.groqApiKey ? '(set, ' + s.settings.groqApiKey.length + ' chars)' : ''}))"
```

## 4. Service worker logs

The background's own `console.log` lines go to the service worker, not the page console. The `background replied` line in the page console is enough for a smoke test; for more, inspect the worker from `chrome://extensions` (Details → "Inspect views: service worker") in a `--headed` session.

## 5. Evidence and cleanup

- `agent-browser --session $S screenshot <scratchpad>/<name>.png` for the YouTube page and the popup.
- `agent-browser --session $S close` when done.
