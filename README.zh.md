# dsh-side-tasks（侧边任务）

**[English](README.md) | [中文](README.zh.md)**

为 DSH Web GUI 制作的 Codex 式「侧边任务」插件。每个侧边任务会把**当前会话
fork 成一个分支**——新会话 id，完整继承项目上下文（cwd、模型、截至最后完成
回合的对话历史）——并以**聊天 Tab** 的形式显示在
[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的右侧
边栏里。你可以在侧边继续与分支对话，它在后台独立执行、不阻塞主会话。
侧边任务是**临时**的：关闭时会确认，并**永久删除**其在 DSH 存储中的会话。

## 能力

- **当前会话的分支** — `sessions.fork`：新 sessionId + 完整继承项目上下文
  （点击时刻之前）
- **聊天 Tab** — 消息历史（含继承的上下文）+ 输入发送（回车发送、Shift+回车
  换行）+ 实时轮询更新
- **右侧边栏 Tab** — 通过 `ctx.betterSidebar.registerTab` 注册（**必需**
  dsh-better-sidebar）；`+` 菜单或 tab 栏打开；badge 显示运行中分支数；tab
  的 ✕ 关闭并确认
- **单一侧边任务** — 新建自动替换旧的（账本只保留当前一个）
- **实时状态** — 待命 / 进行中 / 已完成 / 失败 / 已取消（Host 轮询 + SSE 推送）
- **取消** 运行中的分支回合（幂等）
- **关闭确认** — ✕ 弹出「此侧边任务将不保留，是否关闭？」；确认后取消、移除
  分支，并**永久删除**其在 DSH SQLite 中的会话（事件级联清理）
- **清理历史** — 一键删除历史遗留的侧边任务会话

## 环境要求

- DSH 0.1.0-rc.6+，Node **>= 22.5**（`node:sqlite` 用于关闭时永久删除；Node
  22.0–22.4 上插件仍可运行，但删除功能降级为不删除）
- **dsh-better-sidebar >= 0.12.0（必装）** — 侧边任务以右侧边栏 Tab 形式提供；
  未安装时插件不加载并在控制台给出安装提示（无 DOM 兜底模式）

## 文件

```
dsh-side-tasks/
├── package.json        # 双面 bundle 声明（Host + ./client）
├── cordis.patch.yml    # 一行 insert 行（web profile 装配）
├── src/
│   ├── index.js        # Host 半边：BranchService（fork/prompt/cancel/close
│   │                   #   + history 代理 + poll + SSE + SQLite 删除）
│   └── client.js       # 浏览器半边：better-sidebar Tab + 聊天面板
├── README.md
└── README.zh.md
```

## 安装

```bash
# 在插件目录（本仓库根）执行
dsh plugin --profile web add link:/path/to/dsh-side-tasks

# 验证装配行
dsh --profile web --dump-config | grep -i side-tasks

# 重启 web GUI（Host 代码变更需要；页面会中断一次）
# 然后刷新 http://127.0.0.1:3080
```

卸载：

```bash
dsh plugin --profile web remove dsh-side-tasks
```

## 验证清单

- [ ] better-sidebar 的 `+` 菜单出现「侧边任务」Tab
- [ ] 打开后 fork 当前会话（历史反映继承的上下文）
- [ ] 发送消息在后台执行；回复经轮询刷出
- [ ] 分支运行时主会话仍可正常对话（并行）
- [ ] Tab badge 显示运行状态
- [ ] ✕ 弹出「此侧边任务将不保留，是否关闭？」；确认后分支与其 DSH 会话被移除

## 设计要点

- Host 注入 `apiProxy` / `webServer` / `systemPrompt`；分支用
  `sessions.fork({ sessionId })` 创建（继承 cwd/模型/血缘/种子历史），
  `sessions.prompt(mode: 'queue')` 入队聊天消息。
- 状态对账：轮询 `sessions.list`，并在最后一次 prompt 之后确认 `turn/end`
  （对齐 task-board 的结算逻辑）。
- 路由：`GET /api/side-tasks/state`、`GET /api/side-tasks/history`、
  `POST /api/side-tasks/action`（fork / prompt / cancel / close / purge）、
  `GET /api/side-tasks/events`（SSE + 心跳），受 loopback/同源栅栏保护；
  action 联合不含命令/路径/shell 字段。
- Client 为纯 DOM（无 React），仅 better-sidebar Tab 使用薄 React 壳；样式
  全部走 DSH `--dsw-*` 主题变量。聊天消息每 2s 轮询 history 路由（按 seq
  合并）。
- better-sidebar 集成遵循其[外部插件指南](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/docs/external-plugin-guide.md)：
  `ctx.get('betterSidebar')` 可选探测（非 inject），带短重试阶梯以等待 454KB
  bundle；注册包在 `ctx.effect` 内（HMR 安全卸载）；tab 关闭经 DOM 捕获层
  拦截，取消确认时保持 tab 打开。
- 永久删除：平台**没有会话删除 API**，因此关闭时插件直接从 DSH SQLite 存储
  （`~/.dsh-cc/sessions.sqlite`，可用 `dbPath` 配置）删除会话行——`events`
  经 `ON DELETE CASCADE` 级联，搜索索引自动对账。只删除插件自己 fork 的
  会话。运行中的 DSH 进程持有内存缓存，已删分支会在**下次 DSH 重启**后从
  会话列表消失。
- `node:sqlite` 惰性加载：旧版 Node 22 上插件仍能启动（删除功能降级而非崩溃）。

## License

MIT
