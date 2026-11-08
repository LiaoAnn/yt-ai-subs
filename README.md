# YT AI Subs

一個 Chrome 擴充功能，用 AI 幫 YouTube 影片產生字幕，品質比 YouTube 自動字幕好。字幕可以翻譯成繁體中文（台灣用語），也可以只顯示原文。

- **字幕出現在 YouTube 的 CC 選單裡**：選單會多一條「AI 繁中」（或「AI 英文」、「AI 原文」）字幕軌，由 YouTube 自己的播放器顯示，字型、大小等設定都跟一般字幕一樣。原本沒有字幕的影片也能用。
- **邊看邊產生**：只處理播放位置前面約 30～60 秒的音訊，跳轉時會取消用不到的請求，沒看的部分不花額度。看過的段落會快取，重看不用再花錢。
- **使用 Groq**：先用 Whisper 把語音轉成文字，需要翻譯時再交給 gpt-oss 翻譯。Groq 的免費額度就夠日常使用，擴充本身也會控制請求速度，不會超過上限。
- **主要支援日文、韓文**（也支援英文和自動偵測），可翻譯成繁體中文或英文。

> 音訊直接取自 YouTube 播放器已經載入的內容，不會另外下載影片。

## 安裝

目前沒有上架 Chrome 線上應用程式商店，需要以「未封裝項目」的方式載入。

### 1. 下載

到 [Releases](https://github.com/LiaoAnn/yt-ai-subs/releases/latest) 下載 `yt-ai-subs-v<版本>.zip`，解壓縮到一個固定的資料夾（之後 Chrome 會一直從這裡讀取，不要刪掉）。

<details>
<summary>或是自己從原始碼建置</summary>

需要 Node.js 24 以上，pnpm 由 corepack 提供：

```sh
git clone https://github.com/LiaoAnn/yt-ai-subs.git
cd yt-ai-subs
corepack enable
pnpm install
pnpm build
```

建置結果會放在 `dist/` 資料夾。

也可以用 VS Code 的 Dev Container 開啟專案（設定在 `.devcontainer/`），容器建立時會自動 `pnpm install`，之後在容器裡執行 `pnpm build` 即可。

</details>

### 2. 載入到 Chrome

1. 開啟 `chrome://extensions`。
2. 打開右上角的「開發人員模式」。
3. 點「載入未封裝項目」，選擇解壓縮後的資料夾（自己建置的話是專案裡的 `dist/`）。

更新時，用新版的檔案覆蓋同一個資料夾，到 `chrome://extensions` 按擴充功能上的重新載入按鈕，再重新整理 YouTube 分頁。設定和 API key 會保留。

### 3. 設定 Groq API key

1. 到 [Groq Console](https://console.groq.com/keys) 註冊並建立一組 API key（免費方案就能用）。
2. 點瀏覽器工具列上的 YT AI Subs 圖示，把 key 貼到「Groq API key」欄位。
3. 視需要調整影片語言、是否翻譯、翻譯目標語言和模型，然後儲存。

API key 只會存在這個瀏覽器的 `chrome.storage.local`，只會送到 Groq。

## 使用

1. 打開 YouTube 影片並開始播放。
2. 字幕會自動選上「AI 繁中」字幕軌；沒選上的話，從播放器的 CC（字幕）選單手動選擇。
3. 開播後約 2 秒出現第一句字幕，之後會持續往後產生。

彈出視窗會顯示今天剩下的 Groq 額度和這支影片用掉多少。任一項每日額度剩不到 10% 時，會自動暫停翻譯，只顯示原文。

如果 YouTube 改版導致 CC 選單整合失效，擴充會自動改用自己畫在影片上的字幕。彈出視窗會顯示目前用的是哪一種。

## 開發

技術棧：React、Vite、shadcn/ui、Tailwind CSS、TypeScript 7、oxlint、oxfmt、Vitest。

- `pnpm dev`：檔案變更時自動重新建置 `dist/`
- `pnpm build`：正式建置
- `pnpm test`：單元測試
- `pnpm check`：型別檢查、lint、格式檢查和測試，commit 前要通過

架構、設計決策和開發流程記錄在 [AGENTS.md](AGENTS.md)。

### 發布新版本

把 `public/manifest.json` 和 `package.json` 的 `version` 改成新版本，commit 後推送對應的 tag（例如 `git tag v0.2.0 && git push origin v0.2.0`）。GitHub Actions 會跑檢查、建置，並把 zip 附到新的 Release。
