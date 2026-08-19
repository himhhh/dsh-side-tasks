/**
 * dsh-side-tasks — Host half.
 *
 * Codex-style side tasks for the DSH Web GUI. A side task is a BRANCH of the
 * current conversation: `sessions.fork` creates a new session id that
 * inherits the source's full project context (cwd, model target, seed history
 * up to the last completed turn, lineage). The user chats with the branch in
 * a side panel while it runs in the background — the main conversation is
 * never blocked.
 *
 * Branches are TEMPORARY: closing one cancels its running turn, drops it from
 * the ledger, and — because the platform exposes no session-delete API —
 * permanently deletes the session row from the DSH SQLite store (events
 * cascade). The SQLite path is configurable (default ~/.dsh-cc/sessions.sqlite)
 * and only sessions this plugin forked are ever touched.
 *
 * Routes: GET /api/side-tasks/state, POST /api/side-tasks/action,
 * GET /api/side-tasks/history, GET /api/side-tasks/events (SSE).
 */

import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const SESSION_POLL_MS = 2_000
const ACTION_LIMIT = 64 * 1024
const HEARTBEAT_MS = 15_000
const PROMPT_LIMIT = 8_000
const TITLE_LIMIT = 40

export const API_PREFIX = '/api/side-tasks'

/**
 * `node:sqlite` is experimental and only exists on Node >= 22.5. Load it
 * lazily so the plugin still boots on older Node 22 — the permanent-delete
 * feature degrades to a no-op there instead of crashing the Host.
 */
let sqliteModulePromise
function getDatabaseSync() {
  if (sqliteModulePromise === undefined) {
    sqliteModulePromise = import('node:sqlite').then(
      mod => mod.DatabaseSync,
      () => undefined,
    )
  }
  return sqliteModulePromise
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

export const inject = ['systemPrompt', 'apiProxy', 'webServer']

/** Model-facing announcement: plugin presence and capabilities. */
export const GUIDANCE =
  '本机已安装 dsh-side-tasks 插件（侧边任务）：侧边栏「侧边任务」入口；每个侧边任务是从当前会话 fork 出的独立分支会话（继承完整项目上下文），在后台独立执行，可聊天、可取消、关闭后不保留。用户提到「侧边任务 / side task / 并行任务 / 分支会话」时即指本插件，请据此协作。'

/** Plugin config defaults (hand-rolled: zero runtime dependencies). */
export const DEFAULT_CONFIG = {
  /** When false, the plugin (routes + polling + announcement) is disabled. */
  enabled: true,
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent: true,
  /** DSH SQLite session store; closed side-task branches are permanently
   *  deleted from it (the platform has no delete API). Default: ~/.dsh-cc/sessions.sqlite */
  dbPath: path.join(os.homedir(), '.dsh-cc', 'sessions.sqlite'),
}

/** Wrap one apiProxy RPC payload with a unique request id. */
function request(payload) {
  return { rpcId: `side-tasks-${crypto.randomUUID()}`, payload }
}

function failure(error) {
  return new Error(`${error.code}: ${error.message}`)
}

/** Concatenate text blocks of a message content array (chat rendering). */
function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** A turn/end whose data.reason.kind === 'error' settles the execution as failed. */
function isErrorTurnEnd(data) {
  if (typeof data !== 'object' || data === null) return false
  const reason = data.reason
  return typeof reason === 'object' && reason !== null && reason.kind === 'error'
}

function makeTitle(sourceTitle) {
  if (sourceTitle !== undefined && sourceTitle !== '') {
    return `侧边任务 · ${String(sourceTitle).replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT)}`
  }
  return '侧边任务'
}

export class BranchService {
  constructor(api, options = {}) {
    this.api = api
    /** branchId -> { id, sessionId, parentSessionId, title, status, createdAt, lastPromptAt, endedAt, error } */
    this.branches = new Map()
    this.revision = 0
    this.listeners = new Set()
    this.timers = []
    this.pollInFlight = false
    this.now = options.now ?? Date.now
    this.disposed = false
    this.index = 0
    this.dbPath = options.dbPath ?? DEFAULT_CONFIG.dbPath
  }

  start() {
    if (this.disposed || this.timers.length > 0) return
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.schedulePoll()
  }

  dispose() {
    this.disposed = true
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.listeners.clear()
  }

  /** Serializable, trimmed branch list (no live Host references). */
  snapshot() {
    return {
      schemaVersion: 2,
      revision: this.revision,
      branches: [...this.branches.values()].map(record => ({ ...record })),
    }
  }

  /** SSE frame payload: revision only, never the branch list. */
  eventPayload() {
    return { schemaVersion: 2, revision: this.revision }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  bump() {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Fork the current conversation into a new branch session. The child
   * inherits the source's full project context (fork semantics); it stays
   * idle until the first message is sent.
   *
   * Single-branch model: once the new fork succeeds, every OTHER branch in
   * the ledger is dropped (running turns get a best-effort cancel). This keeps
   * the side task at exactly one, no matter how often the client opens it or
   * how concurrent the open/activate handlers race.
   */
  /**
   * Fork a NEW branch session every time (always the freshest context). The
   * platform cannot delete sessions, so a previous branch's DSH session stays
   * in the session list — but the plugin ledger keeps exactly one branch: the
   * new fork replaces the old record (best-effort cancel of a running turn).
   */
  async forkBranch(sourceSessionId) {
    this.index += 1
    const id = `branch-${this.index}-${crypto.randomUUID().slice(0, 8)}`
    // Name the branch after its source session so the session list shows
    // "侧边任务 · <原标题>" instead of accumulating numbered clones.
    let sourceTitle
    try {
      const list = await this.api.sessions.list(request({}))
      if (list.result.ok) {
        const source = list.result.value.items.find(item => item.sessionId === sourceSessionId)
        sourceTitle = source?.projections?.title ?? source?.title
      }
    } catch {
      // Non-fatal: fall back to the generic title.
    }
    const record = {
      id,
      sessionId: undefined,
      parentSessionId: sourceSessionId,
      title: makeTitle(sourceTitle),
      status: 'creating',
      createdAt: this.now(),
      lastPromptAt: undefined,
      endedAt: undefined,
      error: undefined,
    }
    this.branches.set(id, record)
    this.bump()
    try {
      const forked = await this.api.sessions.fork(request({ sessionId: sourceSessionId }))
      if (!forked.result.ok) throw failure(forked.result.error)
      record.sessionId = forked.result.value.sessionId
      // Rename the child so it reads as a side task in the session list.
      try {
        const renamed = await this.api.sessions.rename(request({ sessionId: record.sessionId, title: record.title }))
        if (!renamed.result.ok) throw failure(renamed.result.error)
      } catch (error) {
        // Cosmetic; a failure must not sink the branch.
        console.warn('[dsh-side-tasks] branch rename failed (non-fatal):', error)
      }
      // Single-branch: drop all other branches now that the new one exists.
      for (const [otherId, other] of this.branches) {
        if (otherId === id) continue
        if (other.status === 'running' && other.sessionId !== undefined) {
          void this.api.sessions.cancel(request({ sessionId: other.sessionId })).catch(() => {})
        }
      }
      for (const otherId of [...this.branches.keys()]) {
        if (otherId !== id) this.branches.delete(otherId)
      }
      record.status = 'idle'
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      record.endedAt = this.now()
    }
    this.bump()
    return this.snapshot()
  }

  /** Queue one user message into a branch session (runs in the background). */
  async promptBranch(branchId, text) {
    const record = this.branches.get(branchId)
    if (record === undefined || record.sessionId === undefined) return this.snapshot()
    try {
      const prompted = await this.api.sessions.prompt(request({
        sessionId: record.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }))
      if (!prompted.result.ok) throw failure(prompted.result.error)
      record.status = 'running'
      record.lastPromptAt = this.now()
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      record.endedAt = this.now()
    }
    this.bump()
    return this.snapshot()
  }

  /** Cancel a running branch turn (idempotent). */
  async cancelBranch(branchId) {
    const record = this.branches.get(branchId)
    if (record === undefined || record.sessionId === undefined) return this.snapshot()
    try {
      const cancelled = await this.api.sessions.cancel(request({ sessionId: record.sessionId }))
      if (!cancelled.result.ok) throw failure(cancelled.result.error)
      record.status = 'cancelled'
      record.endedAt = this.now()
      this.bump()
    } catch (error) {
      console.warn('[dsh-side-tasks] cancel failed:', error)
    }
    return this.snapshot()
  }

  /**
   * Close a branch: best-effort cancel of a running turn, then drop it from
   * the ledger. The DSH session itself cannot be deleted by the platform —
   * it stays in the session list, but the plugin forgets it.
   */
  async closeBranch(branchId) {
    const record = this.branches.get(branchId)
    if (record === undefined) return this.snapshot()
    const sessionId = record.sessionId
    if (record.status === 'running' && sessionId !== undefined) {
      // Await the cancel so the session is no longer being written before the
      // row is deleted — reduces SQLite lock contention with the DSH process.
      try {
        await this.api.sessions.cancel(request({ sessionId }))
      } catch (error) {
        console.warn('[dsh-side-tasks] cancel during close failed (non-fatal):', error)
      }
    }
    this.branches.delete(branchId)
    // Permanently delete the forked session from the DSH store so it stops
    // accumulating in the session list.
    if (sessionId !== undefined) await this.deleteSessionPermanently(sessionId)
    this.bump()
    return this.snapshot()
  }

  /**
   * Permanently delete a session row from the DSH SQLite store. The platform
   * exposes no delete API, so the plugin removes the row directly (events
   * cascade via ON DELETE CASCADE; the search index reconciles on its own).
   * Only sessions this plugin forked are ever targeted. Best-effort: failures
   * are logged and never break the close flow.
   */
  async deleteSessionPermanently(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const DatabaseSync = await getDatabaseSync()
    if (DatabaseSync === undefined) {
      console.warn('[dsh-side-tasks] node:sqlite unavailable (Node < 22.5?); session not permanently deleted')
      return false
    }
    try {
      // A busy timeout matters: the running DSH process holds the store's
      // write lock; without it node:sqlite fails immediately with SQLITE_BUSY.
      const db = new DatabaseSync(this.dbPath, { timeout: 5_000 })
      try {
        const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
        return Number(result.changes ?? 0) > 0
      } finally {
        db.close()
      }
    } catch (error) {
      console.error(`[dsh-side-tasks] failed to delete session ${sessionId}:`, error)
      return false
    }
  }

  /**
   * Remove leftover side-task sessions from a previous run (Host restart
   * loses the ledger, so old branches are orphaned). Matches sessions whose
   * cwd equals the Host cwd and that carry a parent (forked), excluding any
   * branch the plugin still tracks. Manual, user-confirmed operation.
   */
  async purgeHistory() {
    let removed = 0
    const DatabaseSync = await getDatabaseSync()
    if (DatabaseSync === undefined) {
      return { removed: 0, error: 'node:sqlite unavailable (Node < 22.5?)' }
    }
    const active = new Set([...this.branches.values()].map(record => record.sessionId).filter(Boolean))
    const cwd = process.cwd()
    try {
      const db = new DatabaseSync(this.dbPath, { timeout: 5_000 })
      try {
        const rows = db.prepare(
          'SELECT id FROM sessions WHERE parent_session IS NOT NULL AND cwd = ?',
        ).all(cwd)
        const stmt = db.prepare('DELETE FROM sessions WHERE id = ?')
        for (const row of rows) {
          if (active.has(row.id)) continue
          const result = stmt.run(row.id)
          if (Number(result.changes ?? 0) > 0) removed += 1
        }
      } finally {
        db.close()
      }
    } catch (error) {
      console.error('[dsh-side-tasks] purge failed:', error)
      return { removed: 0, error: error instanceof Error ? error.message : String(error) }
    }
    return { removed }
  }

  /** Chat view of a branch session's history: only user/assistant text
   * messages, newest-first paging (beforeSeq), mirroring sessions.history.
   */
  async history(branchId, options = {}) {
    const record = this.branches.get(branchId)
    if (record === undefined || record.sessionId === undefined) {
      return { messages: [], hasMore: false }
    }
    const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 100
    const response = await this.api.sessions.history(request({
      sessionId: record.sessionId,
      maxMessages,
      ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
    }))
    if (!response.result.ok) return { messages: [], hasMore: false }
    const messages = []
    for (const entry of response.result.value.events) {
      const type = entry.event.type
      const seq = entry.event.seq
      const time = entry.event.time
      if (type === 'user/message') {
        const text = extractText(entry.event.data && entry.event.data.content)
        if (text !== '') messages.push({ seq, time, role: 'user', text })
      } else if (type === 'assistant/message') {
        const text = extractText(entry.event.data && entry.event.data.message && entry.event.data.message.content)
        if (text !== '') messages.push({ seq, time, role: 'assistant', text })
      }
    }
    return { messages, hasMore: response.result.value.hasMore === true }
  }

  /** One poll tick: settle running branches via one sessions.list + history. */
  async poll() {
    if (this.disposed) return
    const open = [...this.branches.values()].filter(record => record.status === 'running' && record.sessionId !== undefined)
    if (open.length === 0) return
    let response
    try {
      response = await this.api.sessions.list(request({}))
    } catch {
      return
    }
    if (!response.result.ok) return
    const items = response.result.value.items
    for (const record of open) {
      const summary = items.find(item => item.sessionId === record.sessionId)
      if (summary === undefined) {
        this.settle(record, 'failed', 'branch session no longer exists')
        continue
      }
      if (summary.running) continue
      const outcome = await this.inspect(record)
      if (outcome.outcome === 'pending') continue
      if (outcome.outcome === 'succeeded') this.settle(record, 'done')
      else this.settle(record, 'failed', outcome.error)
    }
  }

  /**
   * Resolve one branch's running-turn outcome: a turn/end at or after the
   * last prompt settles it (mirrors the task-board settlement logic).
   */
  async inspect(record) {
    const anchor = record.lastPromptAt ?? record.createdAt
    const events = []
    let beforeSeq
    let reachedBoundary = false
    for (let page = 0; page < 100; page += 1) {
      const history = await this.api.sessions.history(request({
        sessionId: record.sessionId,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }))
      if (!history.result.ok) return { outcome: 'pending' }
      events.push(...history.result.value.events)
      const oldestTime = history.result.value.events.reduce((oldest, entry) => {
        const time = entry.event.time
        return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
      }, undefined)
      if (!history.result.value.hasMore || (oldestTime !== undefined && oldestTime <= anchor)) {
        reachedBoundary = true
        break
      }
      const oldestSeq = history.result.value.events.reduce((oldest, entry) => {
        const seq = entry.event.seq
        return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
      }, undefined)
      if (oldestSeq === undefined || oldestSeq === beforeSeq) return { outcome: 'pending' }
      beforeSeq = oldestSeq
    }
    if (!reachedBoundary) return { outcome: 'pending' }
    const turnEnd = events
      .filter(entry => entry.event.type === 'turn/end' && (
        typeof entry.event.time !== 'number' || entry.event.time >= anchor
      ))
      .sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0]
    if (turnEnd === undefined) return { outcome: 'pending' }
    return isErrorTurnEnd(turnEnd.event.data)
      ? { outcome: 'failed', error: 'agent turn ended with an error' }
      : { outcome: 'succeeded' }
  }

  settle(record, status, error) {
    record.status = status
    record.error = error
    record.endedAt = this.now()
    this.bump()
  }

  schedulePoll() {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.poll().catch(error => {
      console.error('[dsh-side-tasks] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }
}

/* --- loopback trust fence (mirrors the task-board shared fence) ------------ */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isLoopbackRequest above; do not rely on this marker alone.
 */
function browserSameOriginMarker(req) {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

/* --- routes ----------------------------------------------------------------- */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { raw, value: JSON.parse(raw) }
}

function exactKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key))
}

/**
 * Strict action envelope. The union deliberately contains no command, path,
 * or shell fields: fork / prompt / cancel / close over branch ids.
 */
export function parseAction(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (typeof value.action !== 'string') return undefined
  if (value.action === 'fork') {
    if (!exactKeys(value, ['action', 'sourceSessionId'])) return undefined
    if (typeof value.sourceSessionId !== 'string' || value.sourceSessionId === '') return undefined
    return { kind: 'fork', sourceSessionId: value.sourceSessionId }
  }
  if (value.action === 'prompt') {
    if (!exactKeys(value, ['action', 'branchId', 'text'])) return undefined
    if (typeof value.branchId !== 'string' || value.branchId === '') return undefined
    if (typeof value.text !== 'string') return undefined
    const text = value.text.trim()
    if (text === '' || text.length > PROMPT_LIMIT) return undefined
    return { kind: 'prompt', branchId: value.branchId, text }
  }
  if (value.action === 'cancel' || value.action === 'close') {
    if (!exactKeys(value, ['action', 'branchId'])) return undefined
    if (typeof value.branchId !== 'string' || value.branchId === '') return undefined
    return { kind: value.action, branchId: value.branchId }
  }
  if (value.action === 'purge') {
    if (!exactKeys(value, ['action'])) return undefined
    return { kind: 'purge' }
  }
  return undefined
}

export function makeSideTaskRoutes(service) {
  const guard = (req, res) => {
    if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
    json(res, 403, { ok: false, error: 'forbidden' })
    return false
  }
  const readQuery = (req) => {
    try {
      return new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return undefined
    }
  }
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        json(res, 200, service.snapshot())
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/history`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        const url = readQuery(req)
        if (url === undefined) return json(res, 400, { ok: false, error: 'bad-query' })
        const branchId = url.searchParams.get('branchId')
        if (typeof branchId !== 'string' || branchId === '') {
          return json(res, 400, { ok: false, error: 'branchId-required' })
        }
        const rawBefore = url.searchParams.get('beforeSeq')
        const rawMax = url.searchParams.get('maxMessages')
        const beforeSeq = rawBefore !== null && /^\d+$/.test(rawBefore) ? Number(rawBefore) : undefined
        const maxMessages = rawMax !== null && /^\d+$/.test(rawMax)
          ? Math.min(Number(rawMax), 200)
          : 100
        try {
          const result = await service.history(branchId, { beforeSeq, maxMessages })
          json(res, 200, result)
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/action`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return json(res, 415, { ok: false, error: 'json-required' })
        }
        try {
          const body = await readBody(req, ACTION_LIMIT)
          const parsed = parseAction(body.value)
          if (parsed === undefined) return json(res, 400, { ok: false, error: 'invalid-action' })
          if (parsed.kind === 'purge') {
            const result = await service.purgeHistory()
            return json(res, 200, { ok: true, ...result })
          }
          let snapshot
          if (parsed.kind === 'fork') {
            snapshot = await service.forkBranch(parsed.sourceSessionId)
          } else if (parsed.kind === 'prompt') {
            snapshot = await service.promptBranch(parsed.branchId, parsed.text)
          } else if (parsed.kind === 'cancel') {
            snapshot = await service.cancelBranch(parsed.branchId)
          } else {
            snapshot = await service.closeBranch(parsed.branchId)
          }
          json(res, 200, snapshot)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/events`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end()
          return
        }
        if (!guard(req, res)) return
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const push = () => {
          res.write(`data: ${JSON.stringify(service.eventPayload())}\n\n`)
        }
        const unsubscribe = service.subscribe(push)
        const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
        const close = () => {
          clearInterval(heartbeat)
          unsubscribe()
        }
        req.once('close', close)
        res.once('close', close)
        push()
      },
    },
  ]
}

/* --- single-instance guard -------------------------------------------------- */

const MOUNTED = Symbol.for('dsh-web-ui.mounted-plugins')

function mountedSet() {
  const registry = globalThis
  return (registry[MOUNTED] ??= new Set())
}

/**
 * Wrap a cordis plugin apply so the package runs at most once per process.
 * The first mount registers normally and unmarks when its fiber disposes;
 * any later mount of the same package name is a no-op.
 */
export function mountOnce(packageName, fn) {
  return (...args) => {
    const mounted = mountedSet()
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0]
    ctx?.effect?.(() => () => {
      mounted.delete(packageName)
    })
    return fn(...args)
  }
}

export const apply = mountOnce('dsh-side-tasks', applyImpl)

function applyImpl(ctx, config = {}) {
  const enabled = config.enabled ?? true
  const host = new BranchService(ctx.apiProxy, { dbPath: config.dbPath })
  if (enabled) host.start()

  ctx.effect(() => {
    const disposers = []
    let disposeSection
    try {
      for (const route of makeSideTaskRoutes(host)) disposers.push(ctx.webServer.register(route))
      if (enabled && (config.announceToAgent ?? true)) {
        disposeSection = ctx.systemPrompt.section({
          name: 'plugin:side-tasks',
          order: SECTION_ORDER,
          text: GUIDANCE,
        })
      }
    } catch (error) {
      for (const dispose of disposers) dispose()
      disposeSection?.()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      disposeSection?.()
      host.dispose()
    }
  }, 'side-tasks: host service, routes, and announcement')
}
