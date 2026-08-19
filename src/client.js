/**
 * dsh-side-tasks — Client half.
 *
 * Codex-style side tasks. Clicking the sidebar entry forks the CURRENT
 * conversation into a branch session (`sessions.fork` → new session id, full
 * inherited project context) and opens a SIDE CHAT panel for it — one task,
 * no branch list. The panel renders a faithful Markdown chat (messages,
 * composer, send/cancel) and offers 「在完整窗口打开」 which switches the main
 * chat window to the branch for 100% native functionality (attachments,
 * model picker, every option).
 *
 * The platform exposes no second native conversation view (single-occupant
 * slot, component not exported), so the side chat is framework-free DOM with
 * a small hand-rolled Markdown renderer.
 *
 * Two mounting modes:
 * 1. better-sidebar mode (default): the chat panel is a sidebar TAB; the
 *    left entry forks + opens the tab. The tab component is a thin React
 *    shell mounting the framework-free panel.
 * 2. DOM mode (fallback): left sidebar entry + right-hand drawer.
 *
 * Because the manager may mount before better-sidebar's 454 KB client bundle
 * finishes loading, the plugin starts in DOM mode and auto-switches once
 * `ctx.betterSidebar` appears (retry ladder).
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-tasks',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // React is required: the tab shell mounts through better-sidebar (a
    // mandatory dependency). Missing React means better-sidebar itself cannot
    // run, so the plugin just logs and stays inert.
    var React
    try { React = require('react') } catch { React = undefined }

    // ===== constants =========================================================

    const API_PREFIX = '/api/side-tasks'

    const ENTRY_SELECTOR = '[data-dsh-side-tasks-entry]'
    const FAMILY_SELECTORS = '[data-dsh-side-tasks-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'
    const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'

    const LABEL = '侧边任务'
    const HISTORY_POLL_MS = 2_000

    /** Inline icon (matches the shell's 16px nav-icon look): branch / fork lines. */
    const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="4" r="1.6"/><path d="M5.6 4h2.4a3 3 0 0 1 3 3v3.4"/></svg>'

    const BRANCH_STATUS_META = {
      creating: { label: '创建中', color: 'var(--dsw-alias-state-business-primary)' },
      idle: { label: '待命', color: 'var(--dsw-alias-label-tertiary)' },
      running: { label: '进行中', color: 'var(--dsw-alias-state-warn-primary)' },
      done: { label: '已完成', color: 'var(--dsw-alias-state-success-primary)' },
      failed: { label: '失败', color: 'var(--dsw-alias-state-error-primary)' },
      cancelled: { label: '已取消', color: 'var(--dsw-alias-label-tertiary)' },
    }

    // ===== styles ============================================================

    const CSS_TEXT = `
.st-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.st-entry:hover {
  background: var(--dsw-specific-sidebar-nav-item-hover);
  color: var(--dsw-alias-label-primary);
}
.st-entry[data-active] {
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.st-entryIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.st-entryLabel {
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-frame][data-sidebar-collapsed] .st-entry,
[data-sidebar-collapsed] .st-entry {
  justify-content: center;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] .st-entryLabel,
[data-sidebar-collapsed] .st-entryLabel {
  display: none;
}

/* Chat panel layout shared by both modes. */
.st-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  box-sizing: border-box;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.st-tabRoot {
  height: 100%;
  min-width: 0;
  overflow: hidden;
}
.st-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
}
.st-headerTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  white-space: nowrap;
}
.st-headerTitle .st-titleText {
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-headerActions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.st-iconBtn {
  border: 1px solid var(--dsw-alias-separator-primary);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
}
.st-iconBtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.st-statusLine {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  flex: none;
}
.st-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}

/* Messages */
.st-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
}
.st-msg {
  max-width: 96%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}
.st-msg-user {
  align-self: flex-end;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
  border-bottom-right-radius: 3px;
}
.st-msg-assistant {
  align-self: flex-start;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  border-bottom-left-radius: 3px;
}
.st-msgMeta {
  font-size: 11px;
  opacity: 0.75;
  margin-bottom: 3px;
}
.st-msg .st-md p { margin: 0 0 6px; }
.st-msg .st-md p:last-child { margin-bottom: 0; }
.st-msg .st-md pre {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.12));
  font-family: var(--dsw-font-markdown-code-block-small, monospace);
  white-space: pre;
}
.st-msg .st-md code {
  font-family: var(--dsw-font-markdown-code-block-small, monospace);
  font-size: 12px;
}
.st-msg .st-md :not(pre) > code {
  background: rgba(127,127,127,0.14);
  padding: 1px 4px;
  border-radius: 4px;
}
.st-msg .st-md h1, .st-msg .st-md h2, .st-msg .st-md h3 {
  margin: 6px 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.st-msg .st-md ul, .st-msg .st-md ol {
  margin: 4px 0;
  padding-left: 18px;
}
.st-msg .st-md blockquote {
  margin: 4px 0;
  padding-left: 8px;
  border-left: 3px solid var(--dsw-alias-separator-primary);
  color: var(--dsw-alias-label-secondary);
}
.st-msg .st-md a {
  color: var(--dsw-alias-button-info-fill);
  text-decoration: underline;
}
.st-msg .st-md hr {
  border: none;
  border-top: 1px solid var(--dsw-alias-separator-primary);
  margin: 6px 0;
}
.st-msg .st-md table {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
}
.st-msg .st-md th, .st-msg .st-md td {
  border: 1px solid var(--dsw-alias-separator-primary);
  padding: 3px 8px;
}
.st-msg .st-md strong { font-weight: 600; }
.st-msg .st-md em { font-style: italic; }
.st-empty, .st-error {
  font-size: 12px;
  padding: 14px 8px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}
.st-error {
  color: var(--dsw-alias-state-error-primary);
}

/* Composer */
.st-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  border-top: 1px solid var(--dsw-alias-separator-primary);
  padding-top: 8px;
}
.st-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 46px;
  max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-specific-input-major, var(--dsw-alias-separator-primary));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
}
.st-input:focus {
  outline: none;
  border-color: var(--dsw-alias-button-info-fill);
}
.st-composerRow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.st-btn {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-separator-primary);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 12px;
}
.st-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.st-btnPrimary {
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.st-btnPrimary:hover {
  background: var(--dsw-alias-button-info-hover);
}
.st-btnDanger {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.st-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.st-openFull {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  border: none;
  background: transparent;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
.st-openFull:hover {
  color: var(--dsw-alias-label-primary);
}
`

    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin="dsh-side-tasks"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-side-tasks')
      style.textContent = CSS_TEXT
      document.head.append(style)
    }

    // ===== markdown (small, safe renderer) ===================================

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function escapeUrl(url) {
      // Allow only safe URL schemes; everything else becomes a plain text link.
      const trimmed = String(url).trim()
      return /^(https?:|mailto:|#)/i.test(trimmed) ? trimmed : ''
    }

    function inlineMarkdown(text) {
      let out = escapeHtml(text)
      // Inline code first (protects its content).
      out = out.replace(/`([^`]+)`/g, (_m, code) => '<code>' + code + '</code>')
      // Links: [text](url)
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        const safe = escapeUrl(url)
        return safe === '' ? m : '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noreferrer">' + label + '</a>'
      })
      // Bold / italic
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      return out
    }

    /**
     * Render Markdown text to safe HTML. Handles fenced code blocks, headings,
     * lists, blockquotes, rules, paragraphs and inline styling. Line-by-line,
     * so it is deliberately simple — enough to make the side chat readable.
     */
    function renderMarkdown(text) {
      const lines = String(text).replace(/\r\n/g, '\n').split('\n')
      const html = []
      let i = 0
      let inCode = false
      let codeLang = ''
      let codeLines = []
      let listStack = []

      const closeList = () => {
        while (listStack.length > 0) {
          const tag = listStack.pop()
          html.push('</' + tag + '>')
        }
      }

      while (i < lines.length) {
        const line = lines[i]
        const fence = /^```(.*)$/.exec(line)
        if (fence !== null) {
          if (inCode) {
            html.push('<pre><code' + (codeLang !== '' ? ' class="language-' + escapeHtml(codeLang) + '"' : '') + '>' + escapeHtml(codeLines.join('\n')) + '</code></pre>')
            codeLines = []
            inCode = false
          } else {
            closeList()
            inCode = true
            codeLang = fence[1].trim()
          }
          i += 1
          continue
        }
        if (inCode) {
          codeLines.push(line)
          i += 1
          continue
        }
        if (/^\s*$/.test(line)) {
          closeList()
          i += 1
          continue
        }
        const heading = /^(#{1,3})\s+(.*)$/.exec(line)
        if (heading !== null) {
          closeList()
          const level = heading[1].length
          html.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>')
          i += 1
          continue
        }
        const hr = /^\s*([-*_])\s*\1\s*\1\s*$/.exec(line)
        if (hr !== null) {
          closeList()
          html.push('<hr/>')
          i += 1
          continue
        }
        const blockquote = /^>\s?(.*)$/.exec(line)
        if (blockquote !== null) {
          closeList()
          const quoteLines = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quoteLines.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          html.push('<blockquote>' + inlineMarkdown(quoteLines.join('\n')) + '</blockquote>')
          continue
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        if (bullet !== null) {
          if (listStack[listStack.length - 1] !== 'ul') {
            closeList()
            html.push('<ul>')
            listStack.push('ul')
          }
          html.push('<li>' + inlineMarkdown(bullet[1]) + '</li>')
          i += 1
          continue
        }
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (ordered !== null) {
          if (listStack[listStack.length - 1] !== 'ol') {
            closeList()
            html.push('<ol>')
            listStack.push('ol')
          }
          html.push('<li>' + inlineMarkdown(ordered[1]) + '</li>')
          i += 1
          continue
        }
        // Plain paragraph (gather consecutive non-empty lines).
        closeList()
        const para = []
        while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        html.push('<p>' + inlineMarkdown(para.join('\n')) + '</p>')
      }
      if (inCode) {
        html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>')
      }
      closeList()
      return html.join('')
    }

    // ===== transport (same-origin routes) ====================================

    function createTransport() {
      async function request(url, init) {
        const response = await fetch(url, init)
        const body = await response.json()
        if (!response.ok) throw new Error((body && body.error) || `side-tasks request failed: ${response.status}`)
        return body
      }
      return {
        async state() {
          return await request(`${API_PREFIX}/state`, { cache: 'no-store' })
        },
        async action(payload) {
          return await request(`${API_PREFIX}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        },
        async history(branchId, options = {}) {
          const params = new URLSearchParams({ branchId })
          if (options.beforeSeq !== undefined) params.set('beforeSeq', String(options.beforeSeq))
          if (options.maxMessages !== undefined) params.set('maxMessages', String(options.maxMessages))
          return await request(`${API_PREFIX}/history?${params.toString()}`, { cache: 'no-store' })
        },
        /** Subscribe to Host branch-state changes (revision push). */
        subscribe(listener) {
          const events = new EventSource(`${API_PREFIX}/events`)
          events.onmessage = (message) => {
            try {
              const parsed = JSON.parse(message.data)
              if (parsed === null || typeof parsed !== 'object' || typeof parsed.revision !== 'number') {
                throw new Error('invalid event frame')
              }
              listener(parsed)
            } catch {
              listener(undefined)
            }
          }
          const onVisible = () => {
            if (document.visibilityState === 'visible') listener(undefined)
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            document.removeEventListener('visibilitychange', onVisible)
            events.close()
          }
        },
      }
    }

    // ===== controller ========================================================

    function createController(sessions, transport) {
      // Single side task: at most one active branch.
      const state = {
        revision: 0,
        branch: undefined,     // the one active branch record
        messages: [],          // ascending by seq
        loadedSeq: undefined,
        pendingMessage: undefined, // optimistic user message awaiting real seq
        error: undefined,
      }
      const listeners = new Set()
      let events
      let timer
      let fetchInFlight = false
      let historyInFlight = false
      let disposed = false

      const notify = () => {
        if (disposed) return
        for (const listener of [...listeners]) listener()
      }

      function currentSessionId() {
        try {
          const snapshot = sessions !== undefined && typeof sessions.list?.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : undefined
          return snapshot?.current ?? undefined
        } catch {
          return undefined
        }
      }

      function openSessionInWindow(sessionId) {
        try {
          if (sessions !== undefined && typeof sessions.open === 'function') {
            sessions.open(sessionId)
            return true
          }
        } catch (error) {
          console.warn('[dsh-side-tasks] sessions.open failed:', error)
        }
        return false
      }

      async function refreshState() {
        if (fetchInFlight || disposed) return
        fetchInFlight = true
        try {
          const snapshot = await transport.state()
          state.revision = snapshot.revision
          // Single-branch model: only refresh the attached branch's status.
          // After a close the branch is gone and we do NOT re-attach whatever
          // stale branch the Host may still hold — the next open re-forks.
          if (state.branch !== undefined) {
            state.branch = snapshot.branches.find(item => item.id === state.branch.id) ?? undefined
            if (state.branch === undefined) {
              state.messages = []
              state.loadedSeq = undefined
            }
          }
          notify()
        } catch (error) {
          console.error('[dsh-side-tasks] state fetch failed:', error)
        } finally {
          fetchInFlight = false
        }
      }

      // Fork concurrency guard: onOpen/onActivate can fire back-to-back while
      // a fork is still in flight; only one fork may run at a time.
      let forking = false
      let pendingFork

      /** Fork the current conversation into the side task (if none yet). */
      async function ensureBranch() {
        if (state.branch !== undefined) {
          void loadHistory()
          return true
        }
        if (forking) {
          if (pendingFork !== undefined) await pendingFork
          return state.branch !== undefined
        }
        forking = true
        pendingFork = (async () => {
          const source = currentSessionId()
          if (source === undefined) {
            state.error = '当前没有打开的会话，无法创建侧边任务'
            notify()
            return false
          }
          state.error = undefined
          try {
            const snapshot = await transport.action({ action: 'fork', sourceSessionId: source })
            state.revision = snapshot.revision
            state.branch = snapshot.branches[snapshot.branches.length - 1]
            if (state.branch === undefined || state.branch.sessionId === undefined) {
              throw new Error('branch was not created')
            }
            state.messages = []
            state.loadedSeq = undefined
            notify()
            void loadHistory()
            return true
          } catch (error) {
            state.error = '创建侧边任务失败：' + (error instanceof Error ? error.message : String(error))
            notify()
            return false
          }
        })()
        try {
          return await pendingFork
        } finally {
          forking = false
          pendingFork = undefined
        }
      }

      async function loadHistory() {
        const branch = state.branch
        if (branch === undefined || branch.sessionId === undefined || historyInFlight) return
        historyInFlight = true
        try {
          // Pull the LATEST batch (no beforeSeq — that pages OLDER events).
          // Merge by seq so new messages (own sends, assistant replies)
          // appear as they land, without ever losing earlier ones.
          const result = await transport.history(branch.id, { maxMessages: 100 })
          const incoming = result.messages.slice().reverse()
          const merged = new Map(state.messages.filter(message => !message.pending).map(message => [message.seq, message]))
          for (const message of incoming) merged.set(message.seq, message)
          const mergedList = [...merged.values()].sort((a, b) => a.seq - b.seq)
          // Replace the optimistic pending message once its real user message
          // lands (matched by text; the window is short so collisions are rare).
          const pending = state.pendingMessage
          if (pending !== undefined) {
            const matched = incoming.find(message => message.role === 'user' && message.text === pending.text)
            if (matched !== undefined) state.pendingMessage = undefined
          }
          state.messages = state.pendingMessage !== undefined ? [...mergedList, state.pendingMessage] : mergedList
          if (incoming.length > 0) {
            state.loadedSeq = Math.max(state.loadedSeq ?? 0, ...incoming.map(message => message.seq))
          }
          notify()
        } catch (error) {
          // Transient history failures are silent; the next poll retries.
        } finally {
          historyInFlight = false
        }
      }

      async function send(text) {
        // Auto-recreate a closed side task: sending right after closing the
        // panel should just fork a fresh branch (from the current context)
        // instead of failing with "请先创建侧边任务".
        if (state.branch === undefined) {
          const created = await ensureBranch()
          if (!created) {
            notify()
            return false
          }
        }
        const branch = state.branch
        if (branch === undefined || branch.sessionId === undefined) {
          state.error = '请先创建侧边任务'
          notify()
          return false
        }
        state.error = undefined
        // Optimistic echo: show the message immediately so the panel never
        // looks stuck while the queue waits for the agent to claim it.
        const optimistic = { seq: -1, time: Date.now(), role: 'user', text, pending: true }
        state.pendingMessage = optimistic
        state.messages = [...state.messages, optimistic]
        notify()
        try {
          const snapshot = await transport.action({ action: 'prompt', branchId: branch.id, text })
          state.revision = snapshot.revision
          state.branch = snapshot.branches.find(item => item.id === branch.id) ?? state.branch
          notify()
          await new Promise(resolve => setTimeout(resolve, 250))
          void loadHistory()
          return true
        } catch (error) {
          state.pendingMessage = undefined
          state.messages = state.messages.filter(message => message !== optimistic)
          state.error = '发送失败：' + (error instanceof Error ? error.message : String(error))
          notify()
          return false
        }
      }

      async function cancelActive() {
        const branch = state.branch
        if (branch === undefined || branch.sessionId === undefined) return
        try {
          const snapshot = await transport.action({ action: 'cancel', branchId: branch.id })
          state.revision = snapshot.revision
          state.branch = snapshot.branches.find(item => item.id === branch.id) ?? state.branch
          notify()
        } catch (error) {
          console.warn('[dsh-side-tasks] cancel failed:', error)
        }
      }

      /** Switch the main chat window to the branch (100% native UI). */
      function openFullWindow() {
        const branch = state.branch
        if (branch !== undefined && branch.sessionId !== undefined) {
          openSessionInWindow(branch.sessionId)
        }
      }

      /** Close the side task (optionally skipping the confirm when the caller already asked). */
      async function closeBranch(skipConfirm = false) {
        const branch = state.branch
        if (branch === undefined) return false
        if (!skipConfirm && typeof window !== 'undefined' && !window.confirm('此侧边任务将不保留，是否关闭？')) {
          return false
        }
        const closedSessionId = branch.sessionId
        const parentSessionId = branch.parentSessionId
        // Clear the branch SYNCHRONOUSLY (before the network round-trip) so a
        // follow-up click on the sidebar entry right after closing sees no
        // branch and forks a fresh one instead of racing the stale record.
        state.branch = undefined
        state.messages = []
        state.loadedSeq = undefined
        state.pendingMessage = undefined
        notify()
        try {
          const snapshot = await transport.action({ action: 'close', branchId: branch.id })
          state.revision = snapshot.revision
          // If the chat window is still showing the closed branch, jump back
          // to its parent so the NEXT side task forks from the freshest
          // context (the main conversation) instead of the stale branch.
          if (
            closedSessionId !== undefined
            && parentSessionId !== undefined
            && currentSessionId() === closedSessionId
          ) {
            openSessionInWindow(parentSessionId)
          }
          return true
        } catch (error) {
          // Close failed on the Host: re-attach whatever still exists.
          state.error = '关闭失败：' + (error instanceof Error ? error.message : String(error))
          void refreshState()
          notify()
          return false
        }
      }

      /** Delete leftover side-task sessions from the DSH store (confirmed). */
      async function purgeHistory() {
        if (typeof window !== 'undefined' && !window.confirm('将永久删除所有历史遗留的侧边任务会话（含对话记录，不可恢复）。继续？')) {
          return
        }
        try {
          const result = await transport.action({ action: 'purge' })
          state.error = result.removed > 0
            ? `已清理 ${result.removed} 个历史侧边任务会话`
            : '没有发现可清理的历史侧边任务'
          notify()
        } catch (error) {
          state.error = '清理失败：' + (error instanceof Error ? error.message : String(error))
          notify()
        }
      }

      function startLive() {
        if (events === undefined) {
          events = transport.subscribe((payload) => {
            if (payload === undefined) {
              void refreshState()
              return
            }
            if (payload.revision > state.revision) void refreshState()
          })
        }
        if (timer === undefined) {
          timer = setInterval(() => {
            if (state.branch !== undefined) void loadHistory()
          }, HISTORY_POLL_MS)
        }
      }

      function stopLive() {
        if (events !== undefined) {
          events()
          events = undefined
        }
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }

      function getSnapshot() {
        return {
          revision: state.revision,
          branch: state.branch === undefined ? undefined : { ...state.branch },
          messages: state.messages.map(message => ({ ...message })),
          pendingMessage: state.pendingMessage === undefined ? undefined : { ...state.pendingMessage },
          currentSessionId: currentSessionId(),
          error: state.error,
        }
      }

      return {
        getSnapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        activate: startLive,
        deactivate: stopLive,
        ensureBranch,
        send,
        cancelActive,
        openFullWindow,
        closeBranch,
        purgeHistory,
        dispose() {
          disposed = true
          stopLive()
          listeners.clear()
        },
      }
    }

    // ===== sidebar entry (shared core pattern) ===============================

    function sidebarRoot() {
      const column = document.querySelector(SIDEBAR_SELECTOR)
      if (column === null) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
      return logoOwner ?? (column.firstElementChild ?? undefined)
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested !== null) return nested
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child
      }
      return undefined
    }

    function createEntry(onToggle) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute('data-dsh-side-tasks-entry', '')
      entry.setAttribute('data-dsh-plugin', 'side-tasks')
      entry.setAttribute('data-dsh-part', 'sidebar-entry')
      entry.className = 'st-entry'
      entry.setAttribute('aria-label', LABEL)
      entry.setAttribute('title', LABEL)
      entry.innerHTML = '<span class="st-entryIcon">' + ICON + '</span><span class="st-entryLabel">' + LABEL + '</span>'
      entry.addEventListener('click', onToggle)
      return entry
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (button === undefined) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = (row !== null && row.parentElement === root) ? row : button
        const family = Array.from(root.children).filter(
          (el) => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS),
        )
        const anchor = family.length > 0 ? family[0] : base.nextElementSibling
        root.insertBefore(entry, anchor)
      }
      return true
    }

    function mountSidebarEntry(onToggle) {
      if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
      const entry = createEntry(onToggle)
      let root
      let placed = false
      let rootObserver

      const tryPlace = () => {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect()
          root = undefined
          placed = false
        }
        if (placed) {
          if (document.body.contains(entry)) return
          rootObserver.disconnect()
          root = undefined
          placed = false
        }
        root = root ?? sidebarRoot()
        if (root === undefined) return
        placed = placeEntry(root, entry)
        if (placed) rootObserver.observe(root, { childList: true, subtree: true })
      }

      const waitObserver = new MutationObserver(() => { tryPlace() })
      waitObserver.observe(document.body, { childList: true, subtree: true })

      rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) {
          placed = placeEntry(root, entry)
        }
      })

      tryPlace()

      return () => {
        waitObserver.disconnect()
        rootObserver.disconnect()
        entry.remove()
      }
    }

    // ===== side chat panel ===================================================

    function createChatPanel(controller) {
      const root = document.createElement('div')
      root.className = 'st-panel'
      root.setAttribute('data-dsh-plugin', 'side-tasks')

      // header
      const header = document.createElement('div')
      header.className = 'st-header'
      const title = document.createElement('span')
      title.className = 'st-headerTitle'
      const titleIcon = document.createElement('span')
      titleIcon.innerHTML = ICON
      const titleText = document.createElement('span')
      titleText.className = 'st-titleText'
      titleText.textContent = LABEL
      title.append(titleIcon, titleText)
      const headerActions = document.createElement('div')
      headerActions.className = 'st-headerActions'
      // Clean up leftover side-task sessions from previous runs (Host restart
      // loses the ledger). Manual + confirmed: this permanently deletes DSH
      // sessions whose cwd matches the Host and that carry a parent fork.
      const purgeBtn = document.createElement('button')
      purgeBtn.type = 'button'
      purgeBtn.className = 'st-iconBtn'
      purgeBtn.textContent = '清理历史'
      purgeBtn.title = '删除历史遗留的侧边任务会话（不可恢复）'
      purgeBtn.addEventListener('click', () => { void controller.purgeHistory() })
      headerActions.append(purgeBtn)
      // No in-panel ✕: closing the side task goes through the tab bar's ✕,
      // which routes into closeBranch via the descriptor's onClose.
      header.append(title, headerActions)

      // status line
      const statusLine = document.createElement('div')
      statusLine.className = 'st-statusLine'

      // messages
      const messagesEl = document.createElement('div')
      messagesEl.className = 'st-messages'

      // composer
      const composer = document.createElement('div')
      composer.className = 'st-composer'
      const inputEl = document.createElement('textarea')
      inputEl.className = 'st-input'
      inputEl.placeholder = '在侧边任务中继续对话（后台独立执行，不阻塞当前会话）…'
      inputEl.rows = 2
      const composerRow = document.createElement('div')
      composerRow.className = 'st-composerRow'
      const openFullBtn = document.createElement('button')
      openFullBtn.type = 'button'
      openFullBtn.className = 'st-openFull'
      openFullBtn.textContent = '在完整窗口打开'
      openFullBtn.title = '切换到主聊天窗口查看该分支（100% 原生功能）'
      openFullBtn.addEventListener('click', () => controller.openFullWindow())
      const spacer = document.createElement('span')
      spacer.style.flex = '1'
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'st-btn st-btnDanger'
      cancelBtn.textContent = '取消'
      cancelBtn.style.display = 'none'
      cancelBtn.addEventListener('click', () => { void controller.cancelActive() })
      const sendBtn = document.createElement('button')
      sendBtn.type = 'button'
      sendBtn.className = 'st-btn st-btnPrimary'
      sendBtn.textContent = '发送'
      composerRow.append(openFullBtn, spacer, cancelBtn, sendBtn)
      composer.append(inputEl, composerRow)

      root.append(header, statusLine, messagesEl, composer)

      async function submit() {
        if (sendBtn.disabled) return
        const text = inputEl.value.trim()
        if (text === '') return
        sendBtn.disabled = true
        try {
          const ok = await controller.send(text)
          if (ok) inputEl.value = ''
        } finally {
          sendBtn.disabled = false
        }
      }
      sendBtn.addEventListener('click', () => { void submit() })
      inputEl.addEventListener('keydown', (event) => {
        // Enter sends; Shift+Enter inserts a newline.
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void submit()
        }
      })

      function formatTime(ts) {
        if (typeof ts !== 'number') return ''
        try {
          return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        } catch {
          return ''
        }
      }

      function render() {
        const snapshot = controller.getSnapshot()
        const branch = snapshot.branch
        titleText.textContent = branch !== undefined ? branch.title : LABEL

        // status line
        statusLine.replaceChildren()
        if (branch !== undefined) {
          const meta = BRANCH_STATUS_META[branch.status] ?? { label: branch.status, color: 'var(--dsw-alias-label-tertiary)' }
          const dot = document.createElement('span')
          dot.className = 'st-dot'
          dot.style.background = meta.color
          const text = document.createElement('span')
          text.textContent = meta.label + (branch.error !== undefined ? ' · ' + branch.error : '')
          statusLine.append(dot, text)
        }

        // messages
        messagesEl.replaceChildren()
        if (snapshot.error !== undefined && snapshot.error !== '') {
          const err = document.createElement('div')
          err.className = 'st-error'
          err.textContent = snapshot.error
          messagesEl.append(err)
        }
        if (snapshot.messages.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'st-empty'
          empty.textContent = branch !== undefined
            ? '侧边任务已创建（继承当前会话的完整上下文）。在这里输入消息，或在完整窗口中打开。'
            : '暂无侧边任务。点击侧边栏「侧边任务」图标新建，或直接输入消息自动创建。'
          messagesEl.append(empty)
        } else {
          const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80
          for (const message of snapshot.messages) {
            const bubble = document.createElement('div')
            bubble.className = message.role === 'user' ? 'st-msg st-msg-user' : 'st-msg st-msg-assistant'
            const meta = document.createElement('div')
            meta.className = 'st-msgMeta'
            meta.textContent = (message.role === 'user' ? '你' : '侧边任务') + (message.time !== undefined ? ' · ' + formatTime(message.time) : '')
            const body = document.createElement('div')
            body.className = 'st-md'
            body.innerHTML = renderMarkdown(message.text)
            bubble.append(meta, body)
            messagesEl.append(bubble)
          }
          if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight
        }

        // Live status bubble: "等待回复…" while the prompt is queued,
        // "思考中…" while the agent is running — the panel never looks stuck.
        const pending = snapshot.pendingMessage !== undefined
        const running = branch !== undefined && (branch.status === 'running' || branch.status === 'creating')
        if (pending || running) {
          const thinking = document.createElement('div')
          thinking.className = 'st-msg st-msg-assistant'
          const text = document.createElement('div')
          text.textContent = running ? '思考中…' : '等待回复…'
          thinking.append(text)
          messagesEl.append(thinking)
          messagesEl.scrollTop = messagesEl.scrollHeight
        }

        // composer state
        cancelBtn.style.display = running ? '' : 'none'
        sendBtn.disabled = false
      }

      const unsubscribe = controller.subscribe(render)
      render()

      return {
        root,
        dispose() {
          unsubscribe()
          root.remove()
        },
      }
    }

    // ===== better-sidebar mode: registered tab ===============================

    function iconNode(size = 14) {
      return React.createElement('svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('circle', { cx: 4, cy: 4, r: 1.6 }),
        React.createElement('circle', { cx: 12, cy: 12, r: 1.6 }),
        React.createElement('circle', { cx: 12, cy: 4, r: 1.6 }),
        React.createElement('path', { d: 'M5.6 4h2.4a3 3 0 0 1 3 3v3.4' }),
      )
    }

    /** Badge: running/creating state (hidden when idle or absent). */
    function runningCount(controller) {
      const branch = controller.getSnapshot().branch
      if (branch === undefined) return undefined
      return branch.status === 'running' || branch.status === 'creating' ? 1 : undefined
    }

    function TabHost(props) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const el = ref.current
        if (el === null) return undefined
        const panel = createChatPanel(props.controller)
        el.replaceChildren(panel.root)
        props.controller.activate()
        return () => {
          props.controller.deactivate()
          panel.dispose()
        }
      }, [])
      React.useEffect(() => {
        if (props.visible) props.controller.activate()
        else props.controller.deactivate()
      }, [props.visible])
      return React.createElement('div', { className: 'st-tabRoot', ref }, null)
    }

    function mountBetterSidebarMode(ctx, sessions, bs, transport) {
      const controller = createController(sessions, transport)
      const disposers = []

      /**
       * better-sidebar's closeTab closes the tab FIRST and only then fires the
       * descriptor's onClose — it cannot be vetoed. To make "cancel keeps the
       * tab open" work, intercept the tab-bar ✕ click at the DOM level
       * (capture phase, before better-sidebar's React handler) and run the
       * confirm ourselves; only a confirmed close actually closes the tab.
       */
      const confirmTabClose = async () => {
        if (typeof window !== 'undefined' && !window.confirm('此侧边任务将不保留，是否关闭？')) {
          return // declined: tab stays open, branch untouched
        }
        const closed = await controller.closeBranch(true) // confirm already asked
        if (closed) bs.closeTab('side-tasks')
      }

      const onTabCloseClick = (event) => {
        if (!(event.target instanceof Element)) return
        const closeBtn = event.target.closest('button[aria-label="关闭"], button[aria-label="Close"]')
        if (closeBtn === null) return
        const tab = closeBtn.closest('[class*="tab"]')
        if (tab === null) return
        const titleEl = tab.querySelector('[class*="tabTitle"]')
        if (titleEl === null || titleEl.textContent.trim() !== LABEL) return
        // This is the side-tasks tab's ✕. Without a branch there is nothing
        // to confirm — let the normal close proceed.
        if (controller.getSnapshot().branch === undefined) return
        event.preventDefault()
        event.stopPropagation()
        void confirmTabClose()
      }
      document.addEventListener('click', onTabCloseClick, true)
      disposers.push(() => document.removeEventListener('click', onTabCloseClick, true))

      disposers.push(bs.registerTab({
        id: 'side-tasks',
        title: () => LABEL,
        icon: (size) => iconNode(size),
        order: 100,
        single: true,
        badge: () => runningCount(controller),
        component: (props) => React.createElement(TabHost, { controller, visible: props.visible }),
        // Opening or activating the tab (from the + menu, the tab bar, or a
        // click on an already-open empty tab) must ensure a branch exists.
        // Idempotent: with a branch present it just refreshes the history.
        onOpen: () => { void controller.ensureBranch() },
        onActivate: () => { void controller.ensureBranch() },
        // Fallback close path (if the DOM interception above ever misses):
        // confirm; a declined confirm re-opens the tab so it does not stay
        // closed against the user's wishes.
        onClose: () => {
          if (controller.getSnapshot().branch === undefined) return
          if (typeof window !== 'undefined' && !window.confirm('此侧边任务将不保留，是否关闭？')) {
            bs.openTab({ type: 'side-tasks', path: 'side-tasks://', title: LABEL })
            return
          }
          void controller.closeBranch(true) // confirm already asked
        },
      }))

      return () => {
        controller.dispose()
        for (const dispose of disposers) dispose()
      }
    }

    // ===== apply =============================================================

    exports.inject = ['sessions']

    exports.apply = function apply(ctx) {
      try {
        injectStyle()
        const sessions = ctx.get('sessions')
        const transport = createTransport()
        let disposed = false
        let uiDisposer
        let mounted = false
        let retryTimer

        /** Mount the better-sidebar tab; false when the service is not ready. */
        function tryBetterSidebar() {
          const bs = ctx.get('betterSidebar')
          if (bs === undefined || typeof bs.registerTab !== 'function' || React === undefined) {
            return false
          }
          console.info('[dsh-side-tasks] better-sidebar detected, mounting as sidebar tab')
          uiDisposer = mountBetterSidebarMode(ctx, sessions, bs, transport)
          mounted = true
          return true
        }

        // better-sidebar is REQUIRED. Its 454 KB client bundle may still be
        // loading when this plugin activates, so retry briefly; if it never
        // appears, log a clear hint instead of mounting a fallback UI.
        if (tryBetterSidebar()) {
          console.info('[dsh-side-tasks] mounted in better-sidebar mode')
        } else {
          console.warn('[dsh-side-tasks] dsh-better-sidebar not available yet — retrying…')
          const retries = [250, 700, 1500, 3000, 5000]
          const attempt = (index) => {
            if (disposed || mounted) return
            if (tryBetterSidebar()) return
            if (index < retries.length) retryTimer = setTimeout(() => attempt(index + 1), retries[index])
            else console.error('[dsh-side-tasks] dsh-better-sidebar is required but never appeared; the side task is disabled. Install it via: dsh plugin --profile web add dsh-better-sidebar')
          }
          retryTimer = setTimeout(() => attempt(0), 250)
        }

        ctx.effect(() => () => {
          disposed = true
          if (retryTimer !== undefined) clearTimeout(retryTimer)
          uiDisposer?.()
        }, 'side-tasks: client UI')
      } catch (error) {
        // UI failures degrade the panel, never the GUI.
        console.error('[dsh-side-tasks] client mount failed:', error)
      }
    }

    return module.exports
  },
})
