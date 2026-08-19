# dsh-side-tasks

**[English](README.md) | [中文](README.zh.md)**

Codex-style **side tasks** for the DSH Web GUI. Each side task **forks the
current conversation into a branch** — a new session id that inherits the
full project context (cwd, model, history up to the last completed turn) —
and shows it as a **chat tab** in the [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)
right sidebar. You keep talking to the branch while it runs in the
background; the main conversation is never blocked. Branches are temporary:
closing one confirms and **permanently deletes** it from the DSH store.

## Features

- **Branch of the current conversation** — `sessions.fork`: new session id +
  full inherited project context (as of the moment you open it)
- **Chat tab** — message history (including the inherited context), input +
  send (Enter to send, Shift+Enter for a newline), live polling updates
- **Sidebar tab** — registered via `ctx.betterSidebar.registerTab`
  (**requires** dsh-better-sidebar); opened from the `+` menu or the tab bar;
  badge shows the running branch count; the tab's ✕ closes with a confirm
- **Single side task** — a new branch replaces the previous one (the ledger
  keeps exactly one)
- **Live status** — idle / running / done / failed / cancelled via Host
  polling + SSE push
- **Cancel** a running branch turn (idempotent)
- **Close with confirm** — ✕ asks 「此侧边任务将不保留，是否关闭？」 then
  cancels, drops the branch, and permanently deletes its session from the
  DSH SQLite store (events cascade)
- **Clean up history** — one-click removal of leftover side-task sessions
  from previous runs

## Requirements

- DSH 0.1.0-rc.6+, Node **>= 22.5** (`node:sqlite` powers permanent deletion
  on close; on Node 22.0–22.4 the plugin still runs, but deletion degrades
  to a no-op)
- **dsh-better-sidebar >= 0.12.0 (required)** — the side task is delivered as
  a right-sidebar tab; without it the plugin does not load and logs an install
  hint (no DOM fallback)

## Files

```
dsh-side-tasks/
├── package.json        # dual-face bundle declaration (Host + ./client)
├── cordis.patch.yml    # one-line insert row into the web profile roster
├── src/
│   ├── index.js        # Host half: BranchService (fork/prompt/cancel/close
│   │                   #   + history proxy + poll + SSE + SQLite deletion)
│   └── client.js       # Browser half: better-sidebar tab + chat panel
├── README.md
└── README.zh.md
```

## Install

```bash
# from the plugin directory (this repo root)
dsh plugin --profile web add link:/path/to/dsh-side-tasks

# verify the insert row
dsh --profile web --dump-config | grep -i side-tasks

# restart the web GUI (Host code changes need it; the page interrupts once)
# then refresh http://127.0.0.1:3080
```

Uninstall:

```bash
dsh plugin --profile web remove dsh-side-tasks
```

## Verify

- [ ] The 「侧边任务」 tab appears in the better-sidebar `+` menu
- [ ] Opening it forks the current conversation (history mirrors the context)
- [ ] Sending a message runs in the background; replies appear via polling
- [ ] The main conversation keeps working while a branch runs (parallelism)
- [ ] The tab badge shows the running state
- [ ] ✕ asks 「此侧边任务将不保留，是否关闭？」; confirming removes the branch
      and its session from the DSH store

## Design notes

- Host injects `apiProxy` / `webServer` / `systemPrompt`; a branch is created
  with `sessions.fork({ sessionId })` (inherits cwd/model/lineage/seed
  history), then `sessions.prompt(mode: 'queue')` queues chat messages.
- Status reconciliation polls `sessions.list` and confirms a `turn/end` at or
  after the last prompt (mirrors the task-board settlement logic).
- Routes: `GET /api/side-tasks/state`, `GET /api/side-tasks/history`,
  `POST /api/side-tasks/action` (fork / prompt / cancel / close / purge),
  `GET /api/side-tasks/events` (SSE + heartbeat), guarded by a loopback /
  same-origin fence; the action union contains no command/path/shell fields.
- The client is plain DOM (no React) with a thin React shell for the
  better-sidebar tab; styled with the DSH `--dsw-*` theme tokens. Chat
  messages poll the history route every 2 s (merged by seq).
- better-sidebar integration follows its [external plugin guide](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/docs/external-plugin-guide.md):
  `ctx.get('betterSidebar')` is probed (never injected), with a short retry
  ladder for the 454 KB bundle; registration is wrapped in `ctx.effect` for
  HMR-safe disposal; tab close is intercepted (DOM capture) so a declined
  confirm keeps the tab open.
- Permanent deletion: the platform exposes **no session-delete API**, so on
  close the plugin removes the session row from the DSH SQLite store
  (`~/.dsh-cc/sessions.sqlite`, configurable via `dbPath`) — `events` cascade
  via `ON DELETE CASCADE` and the search index reconciles. Only sessions this
  plugin forked are ever touched. A running DSH process keeps in-memory
  caches, so deleted branches vanish from the session list on the next DSH
  restart.
- `node:sqlite` is loaded lazily so the plugin boots on older Node 22 (the
  delete feature degrades instead of crashing).

## License

MIT
