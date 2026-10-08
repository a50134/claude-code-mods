# Claude Code mods

三個自己用的 Claude Code mod（function hooks 外掛），在 Claude Code 裡加上專案監看面板、額度快用完時的暫存提醒，以及指令／skill 搜尋。

## 目的

- 同時開很多專案時，一眼看出每個專案的狀態、用了多少 token、額度還剩多久重置。
- 額度快用完時，先把進度寫下來，下次可以接著做。
- 指令和 skill 太多記不住，用關鍵字找。

## 使用技術

- TypeScript／TSX，使用 Claude Code 的 function hooks 外掛 API（`claude-code` 型別）
- Node.js（`projects-token-panel` 的統計腳本，只用內建模組）
- 測試使用 `claude-code/testing`，以 `claude plugin test` 執行

## 內容

| 資料夾 | 說明 |
| --- | --- |
| `projects-token-panel/` | 側邊面板：額度用量與重置倒數、自選專案的卡片（狀態、進度條、token、最後提問） |
| `token-saver/` | 5 小時或本週額度超過門檻時，在輸入框上方詢問是否暫存進度；下次開啟時詢問是否接著做 |
| `cmd-finder/` | 查指令和 skill 的搜尋面板，點一下把指令填進輸入框 |

每個 mod 的結構相同：

- `.claude-plugin/plugin.json`：名稱、版本、說明
- `hooks/hooks.json`、`hooks/register.tsx`：hooks 模組
- `types/index.d.ts`：`$.state` 的型別契約
- `tests/*.test.ts`：測試
- `projects-token-panel/scripts/scan.mjs`：掃描本機對話紀錄的統計腳本

### projects-token-panel

- 資料來源是本機 `~/.claude/projects` 底下的對話紀錄，不含子代理；token 計為輸入＋輸出＋快取寫入。
- 專案要自己加入才會顯示：輸入專案或對話名稱的關鍵字，或按「＋加入目前專案」。
- 狀態：進行中、等你回覆、尚有事項未完成、已中斷、出錯停止、已停止、尚無紀錄。
- 進度條：對話裡有待辦清單時用「已完成／總數」，沒有時由使用者手動調整。
- 每張卡片可展開或收合、換顏色；面板可縮小；關掉後輸入框上方會有重開按鈕。
- 另有「繁中」開關，開啟時在系統提示加上一律用繁體中文回覆的規則。
- 指令：`/projects [open|close|add 關鍵字|remove 關鍵字|list|clear]`、`/zh [on|off]`

### token-saver

- 預設門檻：5 小時額度 85%、本週額度 95%，同一個額度週期只問一次。
- 暫存檔寫在專案資料夾的 `.claude/checkpoint.md`。
- 指令：`/checkpoint [save|resume|check|threshold 數字|status]`

### cmd-finder

- 指令：`/find 關鍵字`
- 搜尋範圍是 Claude Code 目前可用的斜線指令（skill 也在其中）。

## 安裝與使用

用 `--plugin-dir` 載入單一 mod：

```bash
claude --plugin-dir /path/to/projects-token-panel
```

要每次都載入，把資料夾路徑寫進環境變數 `CLAUDE_CODE_PLUGIN_DIRS`（多個路徑用系統的路徑分隔符號隔開），可放在 `~/.claude/settings.json` 的 `env` 區塊。

驗證與測試：

```bash
claude plugin validate /path/to/projects-token-panel
```

```bash
claude plugin test /path/to/projects-token-panel
```

## 備註

- `projects-token-panel` 的統計腳本需要 Node.js，並會把 `~/Desktop/Claude-project` 底下的資料夾也列為專案。
- 在 Windows 上開發與使用，其他平台未測試。
