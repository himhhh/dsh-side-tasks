# dsh-side-tasks

Codex-style **side tasks** for the DSH Web GUI. Clicking the sidebar entry
**forks the current conversation into a branch** — a new session id that
inherits the full project context (cwd, model, history up to the last
completed turn) — and opens a **chat panel** for it. You keep talking to the
branch in the side panel while it runs in the background; the main
conversation is never blocked. Branches are temporary: closing one confirms
("此侧边任务将不保留") and drops it.

为 DSH Web GUI 制作的 Codex 式「侧边任务」插件：点击侧边栏「侧边任务」入口，
会把**当前会话 fork 成一个分支**（新会话 id，完整继承项目上下文：cwd、模型、
截至最后完成回合的对话历史），并**弹出一个聊天框**——相当于当前聊天的复制，
你可以在侧边继续与它对话，它在后台独立执行、不阻塞主会话。侧边任务是**临时**
的，关闭时会确认（「此侧边任务将不保留，是否关闭？」）后移除。

## Features / 能力

- **Branch of the current conversation**（当前会话的分支）— `sessions.fork`:
  新 sessionId + 继承完整项目上下文（点击时刻之前）
- **Chat panel**（聊天框）— 消息历史（含复制的上下文）+ 输入发送 + 实时轮询
  更新；每点击一次入口 = 新建一个分支
- **Sidebar TAB**（右侧边栏 Tab）— 通过 `ctx.betterSidebar.registerTab`
  注册（**必需** dsh-better-sidebar），`+` 菜单 / tab 栏打开，badge 显示运行中
  分支数，tab 的 ✕ 关闭并确认删除
- **Single side task**（单一侧边任务）— 新建自动替换旧的（账本只保留当前一个）
- **Live status** — idle / running / done / failed / cancelled via Host polling
  + SSE push
- **Cancel** a running branch turn (idempotent)
- **Close with confirm**（关闭确认）— ✕ asks 「此侧边任务将不保留，是否关闭？」
  then cancels + drops the branch from the ledger

## Files / 文件

```
dsh-side-tasks/
├── package.json        # dual-face bundle declaration (Host + ./client)
├── cordis.patch.yml    # one-line insert row into the web profile roster
├── src/
│   ├── index.js        # Host half: BranchService (fork/prompt/cancel/close
│   │                   #   + history proxy + poll + SSE + routes)
│   └── client.js       # Browser half: chat panel + branch chips + poll
└── README.md
```

## Requirements / 环境要求

- **DSH 0.1.0-rc.6+**, Node **>= 22.5**（`node:sqlite` 用于关闭时永久删除分支会话；Node 22.0–22.4 上插件仍可正常运行，仅"永久删除"降级为不删除）
- **dsh-better-sidebar（必装，>= 0.12.0）**：侧边任务以**右侧边栏 Tab** 形式提供；未安装时插件不加载并在控制台给出安装提示（无 DOM 兜底模式）

## Install / 安装

```bash
# from the plugin directory (this repo root)
dsh plugin --profile web add link:/Users/jimmy/Documents/DeepSeek/dsh侧边任务

# verify the insert row
dsh --profile web --dump-config | grep -i side-tasks

# restart the web GUI (Host code changes need it; the page interrupts once)
# then refresh http://127.0.0.1:3080
```

Uninstall / 卸载:

```bash
dsh plugin --profile web remove dsh-side-tasks
```

## Verify / 验证清单

- [ ] Sidebar shows the 「侧边任务」 entry
- [ ] Clicking it opens a chat panel whose history mirrors the current
      conversation (the fork carries the context)
- [ ] Sending a message runs in the background; replies stream in via polling
- [ ] The main conversation keeps working while a branch runs (parallelism)
- [ ] Multiple branches switch via the chips
- [ ] ✕ asks 「此侧边任务将不保留，是否关闭？」 then drops the branch

## Design notes / 设计要点

- Host injects `apiProxy` / `webServer` / `systemPrompt`; a branch is created
  with `sessions.fork({ sessionId })` (inherits cwd/model/lineage/seed
  history), then `sessions.prompt(mode: 'queue')` queues chat messages.
- Status reconciliation polls `sessions.list` and confirms a `turn/end` at or
  after the last prompt (mirrors the task-board settlement logic).
- Routes: `GET /api/side-tasks/state`, `GET /api/side-tasks/history`,
  `POST /api/side-tasks/action` (fork / prompt / cancel / close),
  `GET /api/side-tasks/events` (SSE + heartbeat), guarded by a loopback /
  same-origin fence; the action union contains no command/path/shell fields.
- The client is plain DOM (no React) with a thin React shell only when
  registering the better-sidebar tab; styled with the DSH `--dsw-*` theme
  tokens. Chat messages poll the history route every 2 s (incremental by seq).
- better-sidebar integration follows its [external plugin guide](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/docs/external-plugin-guide.md):
  `ctx.get('betterSidebar')` is probed (never injected); registration is
  wrapped in `ctx.effect` for HMR-safe disposal.
- Platform limits: DSH exposes **no session-delete API**, so closing a branch
  cancels its running turn and drops it from the plugin ledger, but the forked
  session itself remains in the DSH session list. The ledger is in memory
  (a Host restart drops branch records).

## License

MIT
