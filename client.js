/**
 * Client half of dsh-mcp-companion.
 *
 * Two jobs, both additive and both inside another plugin's existing UI:
 *
 * 1. Skill/MCP panel decoration. A server another plugin mounts itself - the
 *    `wincu` Windows computer-use server is created with
 *    `ctx.plugin(bridge, bridgeConfig(...))` inside dsh-computer-use-win, so it
 *    has no `@deepseek-ai/dsh-mcp-client` row in cordis.patch.yml - cannot
 *    appear in the panel's list, which is built from that file. This module
 *    decorates the panel's Remote results at runtime:
 *
 *      - `list` and `reload` gain one read-only entry per live server the Host
 *        inventory route reports with source "plugin", so the panel's own cards
 *        render them (its Refresh button calls `reload`);
 *      - `test` answers from the live tool registry instead of a missing row;
 *      - `readRaw` explains why no YAML row exists;
 *      - save / setEnabled / removeServer / writeRaw are refused with a readable
 *        reason, because those servers belong to another plugin.
 *
 * 2. Conversation MCP chip. A pill in the New Session row (the additive
 *    `conversation.hero.options` slot, right of the workspace and mode preset
 *    controls) that opens a menu listing the MCP servers with a switch per
 *    server. Each switch writes an override for the current conversation, so
 *    the Host denies those tools for that Agent only - never for the others.
 *
 * This file stays pure ASCII on purpose: the Client bundle builder decodes
 * plugin sources as Latin-1, so non-ASCII literals must be escaped.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-companion',
  factory(require) {
    // The browser module table owns the React runtime; a build without it must
    // still keep the panel decoration working.
    let React
    try { React = require('react') } catch { React = undefined }

    const ENDPOINT = '/local-dsh-customizer/mcp-servers'
    const CLIENT_VERSION = '1.2.11'
    const CHIP_SLOT = 'conversation.hero.options'
    const CHIP_ID = 'mcp-companion.conversation'

    /** Methods the panel uses to change a row: refused for foreign servers. */
    const GUARDED = new Set(['save', 'removeServer', 'writeRaw'])
    /** Methods that answer with the panel's full list result. */
    const LIST_METHODS = new Set(['list', 'reload'])

    /** Objects already wrapped by this page's module instance. */
    const PATCHED_TARGETS = new WeakSet()
    /** Marks the wrapper function itself, so a reloaded bundle does not stack. */
    const PATCH_MARK = Symbol.for('dsh-customizer.patched-invoke')

    const inventory = { value: null, at: 0, pending: null }
    const foreign = new Map()
    const bridges = new Set()

    /** Fire-and-forget status report, visible in the route diagnostics. */
    function report(kind, text) {
      try {
        const url = ENDPOINT + '?diag=' + encodeURIComponent(String(kind))
          + '&text=' + encodeURIComponent(String(text ?? '').slice(0, 280))
          + '&client=' + CLIENT_VERSION
        fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => {})
      } catch {
        // Reporting must never break the UI.
      }
    }

    function fetchJson(url) {
      return fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((response) => response.json())
    }

    /* ------------------------------------------------------------------ */
    /* 1. Skill/MCP panel decoration                                       */
    /* ------------------------------------------------------------------ */

    function refresh(force) {
      const now = Date.now()
      if (!force && inventory.value !== null && now - inventory.at < 5000) {
        return Promise.resolve(inventory.value)
      }
      if (inventory.pending !== null) return inventory.pending
      inventory.pending = fetch(ENDPOINT + '?client=' + CLIENT_VERSION, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
        .then((response) => response.json())
        .then((payload) => remember(payload))
        .catch(() => inventory.value)
        .finally(() => { inventory.pending = null })
      return inventory.pending
    }

    /** Cache one inventory payload and rebuild the plugin-owned lookups. */
    function remember(payload) {
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) return inventory.value
      inventory.value = payload
      inventory.at = Date.now()
      foreign.clear()
      bridges.clear()
      for (const server of Array.isArray(payload.servers) ? payload.servers : []) {
        if (server === null || typeof server !== 'object') continue
        if (server.source !== 'plugin' && server.source !== 'bridge') continue
        foreign.set(String(server.name), server)
        if (server.source === 'bridge') bridges.add(String(server.name))
      }
      return inventory.value
    }

    const ownerOf = (name) => {
      const server = foreign.get(name)
      return server !== undefined && typeof server.provider === 'string' ? server.provider : 'another plugin'
    }

    const messageOf = (name) =>
      name + ' is provided by ' + ownerOf(name)
      + ': it has no @deepseek-ai/dsh-mcp-client row in cordis.patch.yml. '
      + 'The panel shows it read-only; configure it in the settings of that plugin.'

    const rawTextOf = (name) =>
      '# ' + name + ' \u2014 server provided by ' + ownerOf(name) + '\n'
      + '#\n'
      + '# That server is mounted by the plugin itself (ctx.plugin(@deepseek-ai/dsh-mcp-client)),\n'
      + '# so on purpose there is no @deepseek-ai/dsh-mcp-client row here.\n'
      + '# Adding one would start a second server. Use the settings of that plugin.\n'

    /** `serverName` from the args of a namespace method, whichever shape it uses. */
    function serverNameOf(args) {
      const first = Array.isArray(args) ? args[0] : undefined
      if (typeof first === 'string') return first
      if (first !== null && typeof first === 'object') {
        if (typeof first.serverName === 'string') return first.serverName
        if (typeof first.previousServerName === 'string') return first.previousServerName
        if (first.input !== null && typeof first.input === 'object' && typeof first.input.serverName === 'string') {
          return first.input.serverName
        }
      }
      return undefined
    }

    /** The view one live foreign server contributes to the panel list. */
    function viewOf(server) {
      return {
        serverName: String(server.name),
        transport: server.transport === 'http' ? 'streamable-http' : server.transport === 'stdio' ? 'stdio' : 'unknown',
        enabled: server.enabled !== false,
        // The switch is ours: it denies the server's tools while off.
        disabledExpr: false,
        envKeys: [],
        headerKeys: [],
        managed: true,
        orphan: true,
        toolCallTimeoutMs: 90000,
        failOnStartupError: false,
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
        fiberPhase: server.active === true ? 'active' : 'pending',
        toolCount: typeof server.toolCount === 'number' ? server.toolCount : 0,
      }
    }

    /** Only a result with both a servers array and a patch block is the panel's list. */
    function isMcpList(envelope) {
      if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) return false
      const data = envelope.value
      return data !== null && typeof data === 'object'
        && Array.isArray(data.servers)
        && data.patch !== null && typeof data.patch === 'object'
    }

    function augmentList(envelope) {
      const data = envelope.value
      const servers = Array.isArray(data.servers) ? data.servers : []
      return refresh(false).then((payload) => {
        if (payload === null) return envelope
        const rows = Array.isArray(payload.servers) ? payload.servers : []
        const fresh = new Map()
        for (const server of rows) {
          if (server === null || typeof server !== 'object') continue
          if (server.source !== 'plugin' && server.source !== 'bridge') continue
          fresh.set(String(server.name), viewOf(server))
        }
        if (fresh.size === 0) return envelope
        // Replace our own stale entries (a previous bundle may have written
        // them), then append servers the list does not know yet.
        const merged = servers.map((server) => {
          const name = String(server?.serverName ?? '')
          const replacement = fresh.get(name)
          return replacement !== undefined && server?.orphan === true ? replacement : server
        })
        const present = new Set(merged.map((server) => String(server?.serverName ?? '')))
        const additions = [...fresh.values()].filter((view) => !present.has(view.serverName))
        if (additions.length === 0 && merged.every((server, index) => server === servers[index])) return envelope
        return { ...envelope, value: { ...data, servers: [...merged, ...additions] } }
      })
    }

    /** Tool list of the MCP resource bridge: its tools carry no mcp__ prefix. */
    function bridgeToolsOf(name) {
      return refresh(false).then((payload) => {
        const server = payload !== null && Array.isArray(payload.servers)
          ? payload.servers.find((row) => row !== null && row.name === name)
          : undefined
        const tools = (Array.isArray(server?.tools) ? server.tools : []).map((tool) => ({
          name: String(tool?.name ?? ''),
          description: typeof tool?.description === 'string' ? tool.description : '',
        }))
        return {
          ok: true,
          value: { serverName: name, tools, disabled: [], connected: tools.length > 0 },
        }
      })
    }

    function testOf(name) {
      return refresh(false).then((payload) => {
        const server = payload !== null && Array.isArray(payload.servers)
          ? payload.servers.find((row) => row !== null && row.name === name)
          : undefined
        const prefix = 'mcp__' + name + '__'
        const tools = (Array.isArray(server?.tools) ? server.tools : []).map((tool) => ({
          name: typeof tool?.name === 'string' && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : String(tool?.name ?? ''),
          description: typeof tool?.description === 'string' ? tool.description : '',
        }))
        return tools.length === 0
          ? { ok: false, error: { code: 'plugin-managed', message: messageOf(name) } }
          : { ok: true, value: { ok: true, tools } }
      })
    }

    /** Requested state from either call shape: `(name, enabled)` or `({ serverName, enabled })`. */
    function enabledOf(args) {
      const first = Array.isArray(args) ? args[0] : undefined
      if (first !== null && typeof first === 'object' && typeof first.enabled === 'boolean') return first.enabled
      return args[1] === true
    }

    /** Flip one plugin-owned server; the Host persists it and denies its tools. */
    function toggleOf(name, wanted) {
      const url = ENDPOINT + '?toggle=' + encodeURIComponent(name) + '&enabled=' + (wanted ? 'true' : 'false')
      return fetchJson(url)
        .then((payload) => {
          const fresh = remember(payload)
          const server = fresh !== null && Array.isArray(fresh.servers)
            ? fresh.servers.find((row) => row !== null && row.name === name)
            : undefined
          if (server === undefined) {
            return { ok: false, error: { code: 'toggle-failed', message: 'server not found after the switch: ' + name } }
          }
          return { ok: true, value: viewOf(server) }
        })
        .catch((error) => ({
          ok: false,
          error: { code: 'toggle-failed', message: String(error?.message ?? error) },
        }))
    }

    /** Rewrite the answer of one call; everything else passes through. */
    function decorate(method, args, pending) {
      const name = serverNameOf(args)
      if (typeof method !== 'string' || name === undefined || !foreign.has(name)) return pending
      if (method === 'setEnabled') return toggleOf(name, enabledOf(args))
      if (GUARDED.has(method)) {
        return Promise.resolve({ ok: false, error: { code: 'plugin-managed', message: messageOf(name) } })
      }
      if (method === 'readRaw') {
        return Promise.resolve({ ok: true, value: { text: rawTextOf(name) } })
      }
      if (method === 'test') return testOf(name)
      return pending
    }

    /** The patched `invoke` body: rewrite list/reload results and guards only. */
    function afterInvoke(descriptor, values, pending) {
      let method
      try { method = descriptor?.method } catch { return pending }
      if (typeof method !== 'string') return pending
      if (LIST_METHODS.has(method)) {
        return pending.then((envelope) => isMcpList(envelope) ? augmentList(envelope) : envelope)
      }
      if (method === 'listTools') {
        const name = values?.[0]?.serverName
        if (typeof name === 'string' && bridges.has(name)) return bridgeToolsOf(name)
      }
      return decorate(method, values, pending)
    }

    /** `invoke(descriptor, projection, token, callerCtx, values, boundIdentity)` */
    function invokeHook(args, pending) {
      return afterInvoke(args[0], args[4], pending)
    }

    /** `invokeRemote(direct, scoped, callerCtx, values)` */
    function namespaceHook(args, pending) {
      const descriptor = (args[0] ?? args[1])?.descriptor
      return afterInvoke(descriptor, args[3], pending)
    }

    /** Replace `target[key]` with a wrapper that post-processes the returned promise. */
    function tryPatch(target, key, hook) {
      if (PATCHED_TARGETS.has(target)) return true
      let current
      try { current = target[key] } catch { return false }
      if (typeof current === 'function' && current[PATCH_MARK] === true) {
        PATCHED_TARGETS.add(target)
        return true
      }
      let descriptor
      try { descriptor = Object.getOwnPropertyDescriptor(target, key) } catch { return false }
      if (descriptor === undefined || typeof descriptor.value !== 'function' || descriptor.writable !== true) return false
      const original = descriptor.value
      let wrapper
      try {
        wrapper = function patched() {
          return hook(arguments, original.apply(this, arguments))
        }
        wrapper[PATCH_MARK] = true
        target[key] = wrapper
      } catch {
        return false
      }
      let ok = false
      try { ok = target[key] === wrapper } catch { ok = false }
      if (!ok) return false
      PATCHED_TARGETS.add(target)
      return true
    }

    /**
     * Patch the Remote service once. The class method `invoke` is the funnel of
     * every generated namespace method, so a namespace rename, a panel update
     * or a re-mount does not drop the decoration.
     */
    function install(ctx) {
      let remote
      try {
        remote = typeof ctx.get === 'function' ? ctx.get('remote') : undefined
      } catch {
        return false
      }
      if (remote === undefined || remote === null) return false
      if (PATCHED_TARGETS.has(remote)) return true

      let done = false
      // The service instance, when its own `invoke` is writable.
      done = tryPatch(remote, 'invoke', invokeHook) || done

      // Every prototype in the chain that owns `invoke` (the class method).
      let proto = remote
      for (let depth = 0; depth < 6 && proto !== null && proto !== undefined; depth += 1) {
        try { proto = Object.getPrototypeOf(proto) } catch { break }
        if (proto === null || proto === undefined) break
        let own
        try { own = Object.getOwnPropertyDescriptor(proto, 'invoke') } catch { own = undefined }
        if (own !== undefined && typeof own.value === 'function') {
          done = tryPatch(proto, 'invoke', invokeHook) || done
        }
      }

      // Each mounted MCP namespace's own `invokeRemote` hook, as a fallback.
      try {
        const map = remote.namespaces
        if (map !== undefined && map !== null && typeof map.forEach === 'function') {
          map.forEach((handle) => {
            const service = handle?.service
            if (service === undefined || service === null || PATCHED_TARGETS.has(service)) return
            if (typeof service.invokeRemote !== 'function') return
            const methods = service.methods
            if (methods === undefined || typeof methods.has !== 'function') return
            if (!methods.has('list') && !methods.has('reload')) return
            if (!methods.has('test') || !methods.has('setEnabled')) return
            try {
              const original = service.invokeRemote.bind(service)
              service.invokeRemote = function patchedInvokeRemote(direct, scoped, callerCtx, args) {
                return namespaceHook(arguments, original(direct, scoped, callerCtx, args))
              }
              PATCHED_TARGETS.add(service)
              done = true
            } catch {
              // Not writable in this build; the prototype patch already covers it.
            }
          })
        }
      } catch {
        // Namespace map is private in this build.
      }

      return done
    }

    /* ------------------------------------------------------------------ */
    /* 2. Conversation MCP chip                                            */
    /* ------------------------------------------------------------------ */

    const CHIP_CSS = [
      '.dsh-mcp-chip-host{display:inline-flex;align-items:center;min-width:0}',
      '.dsh-mcp-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;',
      'border-radius:9px;border:1px solid transparent;background:transparent;',
      'color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;',
      'transition:background .12s ease,border-color .12s ease}',
      '.dsh-mcp-chip:hover,.dsh-mcp-chip[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2, #2c2c2e)}',
      '.dsh-mcp-chip .dsh-mcp-chev{transition:transform .15s ease}',
      '.dsh-mcp-chip[aria-expanded="true"] .dsh-mcp-chev{transform:rotate(180deg)}',
      '.dsh-mcp-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:320px;max-height:60vh;',
      'display:flex;flex-direction:column;padding:6px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2, #3a3a3e);background:var(--dsw-alias-bg-layer-2, #2c2c2e);',
      'box-shadow:0 16px 40px rgba(0,0,0,.45);color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsh-mcp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:6px 8px 8px;font-size:11px;font-weight:600;letter-spacing:.04em;',
      'text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dsh-mcp-head-total{font-weight:600;letter-spacing:0;text-transform:none;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}',
      '.dsh-mcp-head-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcp-tokens{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}',
      '.dsh-mcp-list{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh-mcp-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;',
      'cursor:pointer;user-select:none;outline:none}',
      '.dsh-mcp-row:hover,.dsh-mcp-row:focus-visible{background:rgba(255,255,255,.06)}',
      '.dsh-mcp-row[data-locked="true"]{cursor:default;opacity:.55}',
      '.dsh-mcp-row[data-locked="true"]:hover{background:transparent}',
      '.dsh-mcp-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-mcp-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcp-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcp-switch{position:relative;width:30px;height:17px;border-radius:99px;flex:none;box-sizing:border-box;',
      'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.10);',
      'transition:background .15s ease,border-color .15s ease}',
      '.dsh-mcp-switch::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;',
      'border-radius:50%;background:var(--dsw-alias-label-secondary, #9aa0a6);',
      'transition:transform .15s ease,background .15s ease}',
      '.dsh-mcp-switch[data-on="true"]{background:var(--dsw-alias-label-primary, #f2f2f2);border-color:transparent}',
      '.dsh-mcp-switch[data-on="true"]::after{transform:translateX(13px);',
      'background:var(--dsw-alias-bg-base, #151517)}',
      '.dsh-mcp-note{padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}',
      '.dsh-mcp-foot{padding:8px 8px 2px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);',
      'border-top:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08));margin-top:4px}',
    ].join('')

    const PLUG_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4"/></svg>'
    const CHEVRON = '<svg class="dsh-mcp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none"'
      + ' stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'

    function ensureStyles() {
      try {
        const existing = document.getElementById('dsh-mcp-companion-styles')
        if (existing !== null) {
          // A reloaded bundle keeps the previous sheet in the head; refresh its
          // content so new rules apply without a page reload.
          if (existing.textContent !== CHIP_CSS) existing.textContent = CHIP_CSS
          return
        }
        const style = document.createElement('style')
        style.id = 'dsh-mcp-companion-styles'
        style.textContent = CHIP_CSS
        document.head.appendChild(style)
      } catch {
        // A page without a head still gets the chip, just unstyled.
      }
    }

    const labelOf = (server) => String(server?.name ?? '')

    /** Compact token count: 812, 3.4k, 12k. */
    function formatTokens(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (number <= 0) return ''
      if (number >= 10000) return Math.round(number / 1000) + 'k tok'
      if (number >= 1000) {
        const short = (Math.round(number / 100) / 10).toFixed(1)
        return (short.endsWith('.0') ? short.slice(0, -2) : short) + 'k tok'
      }
      return String(number) + ' tok'
    }

    function subtitleOf(server) {
      const parts = []
      const count = typeof server?.toolCount === 'number' ? server.toolCount : 0
      parts.push(count + (count === 1 ? ' tool' : ' tools'))
      if (server?.source === 'bridge') parts.push('MCP resources')
      else if (server?.source === 'profile') parts.push('declared')
      else if (typeof server?.provider === 'string' && server.provider.length > 0) parts.push(server.provider)
      if (server?.override === 'on') parts.push('enabled here')
      else if (server?.override === 'off') parts.push('disabled here')
      else if (server?.globalEnabled === false) parts.push('disabled everywhere')
      return parts.join(' \u00b7 ')
    }

    /**
     * Build the chip button inside `node` and return its disposer. The button
     * lives in the slot's flow; the menu is appended to <body> so no ancestor
     * can clip it, and is positioned from the button's rect.
     */
    function mountChip(node, sessionId) {
      if (node === null || node === undefined || typeof node.appendChild !== 'function') return undefined
      ensureStyles()

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-mcp-chip'
      button.title = 'MCP for this conversation'
      button.setAttribute('aria-haspopup', 'dialog')
      button.setAttribute('aria-expanded', 'false')
      button.innerHTML = PLUG_ICON + '<span>MCP</span>' + CHEVRON
      node.appendChild(button)

      // The row's option group is right-aligned, so a chip registered there
      // lands at the far right. `position: relative` plus a negative `left`
      // moves only the painted box: no layout change, so no feedback loop and
      // nothing else in the row moves. The anchor is the element that precedes
      // this chip's group (the workspace and preset controls), found by walking
      // up until a preceding sibling exists - never by matching its text, so a
      // locale or label change cannot break it.
      let shift = 0

      /**
       * The control the chip should follow: the last compact element before
       * this chip's group in the row. Wide layout spacers are skipped, so a
       * `justify-content: space-between` row and a row of plain siblings both
       * resolve to the workspace/preset cluster.
       */
      /**
       * The first painted box at or inside `el`. Slot renderers may wrap an
       * occupant in a `display: contents` element, whose own rect is empty:
       * looking only at the wrapper's rect makes the real control invisible to
       * the anchor search.
       */
      function boxOf(el, depth) {
        let rect
        try { rect = el.getBoundingClientRect() } catch { return null }
        if (rect !== null && rect !== undefined && (rect.width > 0 || rect.height > 0)) return rect
        if (depth <= 0) return null
        let children
        try { children = el.children } catch { return null }
        if (children === null || children === undefined || typeof children.length !== 'number') return null
        for (const child of children) {
          const inner = boxOf(child, depth - 1)
          if (inner !== null) return inner
        }
        return null
      }

      function anchorOf() {
        const own = button.getBoundingClientRect()
        // Use the flow position, not the painted one: the applied offset must
        // never make the real anchor look too far away, or the search falls
        // back to an earlier control and the two steal the chip from each other.
        const flowLeft = own.left - shift
        const centre = (own.top + own.bottom) / 2
        let cursor = node
        for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
          const parent = cursor.parentElement
          if (parent === null) break
          let sibling = cursor.previousElementSibling
          while (sibling !== null) {
            const rect = boxOf(sibling, 3)
            if (rect !== null) {
              const sameLine = Math.abs(((rect.top + rect.bottom) / 2) - centre) <= 40
              const controlLike = rect.width > 12 && rect.width < 760 && rect.height >= 18 && rect.height <= 72
              // A real gap means this is the row's free space, not a tight
              // neighbour: only such a control is worth following.
              if (sameLine && controlLike && (flowLeft - rect.right) >= 60) return rect
            }
            sibling = sibling.previousElementSibling
          }
          cursor = parent
        }
        return null
      }

      function align() {
        try {
          const anchor = anchorOf()
          const own = button.getBoundingClientRect()
          if (own.width === 0) return
          if (anchor === null) {
            if (shift !== 0) {
              shift = 0
              node.style.left = ''
            }
            return
          }
          const a = anchor
          if (a.width < 12) return
          // The flow position is the measured left minus whatever offset this
          // function already applied, so repeated calls converge on the same
          // target instead of accumulating.
          const base = own.left - shift
          const target = a.right + 2
          let next = target - base
          if (Math.abs(next) < 2) next = 0
          // Never push the chip rightwards over a neighbour, never off the row.
          if (next > 6 || base + next < 4) return
          if (Math.abs(next - shift) < 0.5) return
          shift = next
          node.style.position = 'relative'
          node.style.zIndex = '2'
          node.style.left = shift + 'px'
          // Diagnostics only: proves which control the chip was seated after.
          report('align', Math.round(shift) + '|' + Math.round(a.width) + '|' + Math.round(a.right))
        } catch {
          // Layout unavailable: leave the chip where the slot put it.
        }
      }

      align()
      // The mode preset mounts its own control asynchronously, so the row is
      // still incomplete on the first frame. A throttled animation loop keeps
      // re-measuring while the hero is on screen: it snaps into place as soon
      // as the preset exists, with no timers to tune and no observers on
      // another plugin's subtree.
      let frame = 0
      let ticks = 0
      let stopped = false
      const step = () => {
        if (stopped) return
        frame = requestAnimationFrame(step)
        ticks += 1
        if (ticks % 5 !== 0) return
        try { align() } catch { /* align already guards itself */ }
      }
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(step)
      window.addEventListener('resize', align)

      let menu = null
      let timer = null
      let payload = null

      const hasSession = typeof sessionId === 'string' && sessionId.length > 0

      function urlFor(extra) {
        const params = []
        if (hasSession) params.push('session=' + encodeURIComponent(sessionId))
        params.push('client=' + CLIENT_VERSION)
        if (typeof extra === 'string' && extra.length > 0) params.push(extra)
        return ENDPOINT + '?' + params.join('&')
      }

      function place() {
        if (menu === null) return
        const rect = button.getBoundingClientRect()
        const width = 320
        const height = menu.offsetHeight || 260
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        let top = rect.bottom + 8
        if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8)
        menu.style.left = left + 'px'
        menu.style.top = top + 'px'
      }

      function note(text) {
        const element = document.createElement('div')
        element.className = 'dsh-mcp-note'
        element.textContent = text
        return element
      }

      function rowElement(server) {
        const row = document.createElement('div')
        row.className = 'dsh-mcp-row'
        row.setAttribute('role', 'menuitemcheckbox')
        const on = server?.enabled !== false
        const locked = server?.active !== true && server?.toggleable !== true
        row.setAttribute('aria-checked', String(on))
        if (locked) row.dataset.locked = 'true'

        const text = document.createElement('div')
        text.className = 'dsh-mcp-text'
        const name = document.createElement('div')
        name.className = 'dsh-mcp-name'
        name.textContent = labelOf(server)
        const sub = document.createElement('div')
        sub.className = 'dsh-mcp-sub'
        sub.textContent = subtitleOf(server)
        text.appendChild(name)
        text.appendChild(sub)

        const tokens = formatTokens(server?.tokens)
        const badge = document.createElement('div')
        badge.className = 'dsh-mcp-tokens'
        badge.textContent = tokens
        badge.title = 'Weight of the schemas of this server in the context'

        const toggle = document.createElement('div')
        toggle.className = 'dsh-mcp-switch'
        toggle.dataset.on = String(on)

        row.appendChild(text)
        if (tokens !== '') row.appendChild(badge)
        row.appendChild(toggle)

        if (!locked) {
          row.tabIndex = 0
          row.addEventListener('click', () => { flip(labelOf(server), !on) })
          row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              flip(labelOf(server), !on)
            }
          })
        }
        return row
      }

      function render() {
        if (menu === null) return
        const servers = Array.isArray(payload?.servers) ? payload.servers : []
        const rows = servers.filter((server) => server !== null && typeof server === 'object'
          && (server.toggleable === true || server.active === true))

        const head = document.createElement('div')
        head.className = 'dsh-mcp-head'
        const headLabel = document.createElement('span')
        headLabel.className = 'dsh-mcp-head-label'
        headLabel.textContent = 'MCP for this conversation'
        head.appendChild(headLabel)
        const activeTokens = rows.reduce((total, server) => total
          + (server?.enabled === false ? 0 : (typeof server?.tokens === 'number' ? server.tokens : 0)), 0)
        if (activeTokens > 0) {
          const headTotal = document.createElement('span')
          headTotal.className = 'dsh-mcp-head-total'
          headTotal.textContent = formatTokens(activeTokens)
          headTotal.title = 'Total weight of the MCP tools active in this conversation'
          head.appendChild(headTotal)
        }

        const list = document.createElement('div')
        list.className = 'dsh-mcp-list'
        if (payload === null) list.appendChild(note('Loading\u2026'))
        else if (rows.length === 0) list.appendChild(note('No active MCP server.'))
        else for (const server of rows) list.appendChild(rowElement(server))

        const foot = document.createElement('div')
        foot.className = 'dsh-mcp-foot'
        foot.textContent = hasSession
          ? 'This setting only applies to this conversation.'
          : 'Open a conversation to set its MCP servers.'

        while (menu.firstChild !== null) menu.removeChild(menu.firstChild)
        menu.appendChild(head)
        menu.appendChild(list)
        menu.appendChild(foot)
        place()
      }

      function load() {
        return fetchJson(urlFor())
          .then((next) => {
            if (next !== null && typeof next === 'object' && next.ok === true) payload = next
            render()
          })
          .catch((error) => {
            payload = { ok: false, servers: [] }
            render()
            report('chip-load-error', String(error?.message ?? error))
          })
      }

      function flip(name, wanted) {
        if (!hasSession) return
        const extra = 'toggle=' + encodeURIComponent(name) + '&enabled=' + (wanted ? 'true' : 'false')
        fetchJson(urlFor(extra))
          .then((next) => {
            if (next !== null && typeof next === 'object' && next.ok === true) {
              payload = next
              render()
              report('chip-toggle', name + '=' + String(wanted))
            } else {
              report('chip-toggle-error', String(next?.error ?? 'inconnu'))
            }
          })
          .catch((error) => { report('chip-toggle-error', String(error?.message ?? error)) })
      }

      function onOutside(event) {
        if (menu === null) return
        if (menu.contains(event.target) || button.contains(event.target)) return
        close()
      }

      function onKey(event) {
        if (event.key === 'Escape') close()
      }

      function close() {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
        document.removeEventListener('mousedown', onOutside, true)
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('resize', place)
        if (menu !== null) {
          menu.remove()
          menu = null
        }
        button.setAttribute('aria-expanded', 'false')
      }

      function open() {
        if (menu !== null) return
        align()
        menu = document.createElement('div')
        menu.className = 'dsh-mcp-menu'
        menu.setAttribute('role', 'dialog')
        menu.setAttribute('aria-label', 'MCP for this conversation')
        document.body.appendChild(menu)
        button.setAttribute('aria-expanded', 'true')
        render()
        load()
        timer = setInterval(load, 4000)
        document.addEventListener('mousedown', onOutside, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', place)
      }

      button.addEventListener('click', () => { if (menu === null) open(); else close() })

      return function disposeChip() {
        close()
        stopped = true
        try { if (frame !== 0) cancelAnimationFrame(frame) } catch { /* already gone */ }
        window.removeEventListener('resize', align)
        try { button.remove() } catch { if (button.parentNode !== null) button.parentNode.removeChild(button) }
      }
    }

    /** The slot component: a React shell whose children are the plain-DOM chip. */
    function ConversationMcpChip(props) {
      const sessionId = props !== null && typeof props === 'object' && typeof props.sessionId === 'string'
        ? props.sessionId
        : undefined
      const holder = React.useRef(null)
      React.useEffect(() => {
        const node = holder.current
        if (node === null || node === undefined) return undefined
        const dispose = mountChip(node, sessionId)
        report('chip-mount', sessionId ?? 'no-session')
        return () => { if (typeof dispose === 'function') dispose() }
      }, [sessionId])
      return React.createElement('span', { className: 'dsh-mcp-chip-host', ref: holder })
    }

    /** Register the chip in the New Session row, right of the mode preset. */
    function installChip(ctx) {
      if (React === undefined || React === null || typeof React.createElement !== 'function') {
        report('chip-slot-error', 'react runtime unavailable')
        return false
      }
      let slots
      try {
        slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
        if (slots === undefined || slots === null) slots = ctx.slots
      } catch {
        slots = undefined
      }
      if (slots === undefined || slots === null || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        report('chip-slot-error', 'slots service unavailable')
        return false
      }
      try {
        // A negative order keeps the chip first in the row's option group, so
        // it sits as close as possible to the workspace and preset controls.
        const register = () => slots.register({
          name: CHIP_SLOT,
          id: CHIP_ID,
          order: -10,
          label: 'MCP for this conversation',
        }, ConversationMcpChip)
        slots.inject(CHIP_SLOT, register)
        report('chip-slot', CHIP_SLOT)
        return true
      } catch (error) {
        report('chip-slot-error', String(error?.message ?? error))
        return false
      }
    }

    /* ------------------------------------------------------------------ */
    /* 3. Skill/MCP page tabs: tool definitions and prompt sections        */
    /* ------------------------------------------------------------------ */
    /*
     * dsh-skill-mcp-panel renders ONE page in the `main` slot with its own
     * "Skills | MCP" tab strip. It exposes no slot inside that page, so the
     * only additive way to add a tab is to decorate its rendered DOM:
     *
     *   - two buttons cloned from its own tab button (same classes, same look)
     *     are appended to its `[role="tablist"]`, so the strip is untouched;
     *   - one body element is appended to the page root and shown only while
     *     one of our tabs is selected;
     *   - its own content stays mounted and is hidden inline, and its own tab
     *     highlight is only de-emphasized by a stylesheet rule keyed on
     *     `data-mcpc-active`, so React state is never fought over;
     *   - a MutationObserver repairs the few things React can undo (a swapped
     *     content node reappearing, the page being re-rendered).
     *
     * Every entry point is guarded: a panel that changes shape must leave the
     * page usable, with our tabs simply absent.
     */

    const PAGE_STYLE_ID = 'dsh-mcp-companion-page-styles'
    const PAGE_TABS = [
      { id: 'tools', label: 'Tools', heading: 'Tool definitions' },
      { id: 'prompts', label: 'System prompt', heading: 'System prompt sections' },
    ]

    const PAGE_CSS = [
      // The panel's own tab stays React-active while ours is selected; only its
      // highlight is muted (the underline is drawn by the plugin's ::after).
      '[data-mcpc-active="1"]>[role="tablist"]>button:not([data-mcpc-tab]){color:var(--dsw-alias-label-secondary);',
      'font-weight:400}',
      '[data-mcpc-active="1"]>[role="tablist"]>button:not([data-mcpc-tab])::after{transform:scaleX(0)!important}',
      '.dsh-mcpc-body{display:none;flex-direction:column;gap:12px;width:100%;box-sizing:border-box;',
      'flex:1;min-height:0;overflow-y:auto;padding:0 clamp(20px,3vw,40px) 40px;max-width:1040px;margin:0 auto}',
      // The body is a flex column: without this its children shrink to the
      // capped height and the rows get clipped instead of scrolling.
      '.dsh-mcpc-body>*{flex:0 0 auto}',
      '.dsh-mcpc-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dsh-mcpc-title{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dsh-mcpc-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}',
      '.dsh-mcpc-total{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}',
      '.dsh-mcpc-group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dsh-mcpc-grouphead{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-mcpc-groupname{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcpc-groupmeta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);',
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}',
      '.dsh-mcpc-row{display:flex;align-items:center;gap:10px;padding:8px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-mcpc-row:last-child{border-bottom:none}',
      '.dsh-mcpc-row[data-off="true"] .dsh-mcpc-rowname{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-mcpc-rowtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;cursor:pointer;',
      'background:0 0;border:0;padding:0;text-align:left;font:inherit;color:inherit}',
      '.dsh-mcpc-rowtext[data-static="true"]{cursor:default}',
      '.dsh-mcpc-rowname{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcpc-rowsub{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-mcpc-tok{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);',
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}',
      '.dsh-mcpc-switch{width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);position:relative;cursor:pointer;flex:none;padding:0;',
      'transition:background-color .18s ease,border-color .18s ease}',
      '.dsh-mcpc-switch[data-on="true"]{background:var(--dsw-alias-label-primary);border-color:transparent}',
      '.dsh-mcpc-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
      'background:var(--dsw-alias-label-secondary);transition:transform .18s ease,background-color .18s ease;display:block}',
      '.dsh-mcpc-switch[data-on="true"]>.dsh-mcpc-knob{transform:translateX(16px);background:var(--dsw-alias-bg-base,#000)}',
      '.dsh-mcpc-switch:disabled{opacity:.4;cursor:default}',
      '.dsh-mcpc-pre{margin:0;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));',
      'color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;',
      'font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}',
      '.dsh-mcpc-note{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary);padding:6px 2px}',
      '.dsh-mcpc-note[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-mcpc-tag{font-size:10.5px;line-height:15px;padding:1px 6px;border-radius:5px;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);flex:none;white-space:nowrap}',
    ].join('')

    /** The decorated page, or null while the panel is closed. */
    let PAGE = null

    function ensurePageStyles() {
      try {
        const existing = document.getElementById(PAGE_STYLE_ID)
        if (existing !== null) {
          if (existing.textContent !== PAGE_CSS) existing.textContent = PAGE_CSS
          return
        }
        const style = document.createElement('style')
        style.id = PAGE_STYLE_ID
        style.textContent = PAGE_CSS
        document.head.appendChild(style)
      } catch {
        // Unstyled tabs are still usable.
      }
    }

    function childBy(element, match) {
      if (element === null || element === undefined) return null
      const kids = element.children
      if (kids === null || kids === undefined) return null
      for (let index = 0; index < kids.length; index += 1) {
        const kid = kids[index]
        try {
          if (match(kid) === true) return kid
        } catch {
          // A single odd node must not stop the search.
        }
      }
      return null
    }

    function tagIs(element, name) {
      return String(element?.tagName ?? '').toUpperCase() === name
    }

    /** The panel page: a `[data-tab]` root whose second child is a tab strip. */
    function findPageRoot() {
      try {
        if (typeof document.querySelectorAll !== 'function') return null
        const nodes = document.querySelectorAll('[data-tab]')
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index]
          const strip = childBy(node, (kid) => kid?.getAttribute?.('role') === 'tablist')
          if (strip === null) continue
          const tab = String(node.getAttribute?.('data-tab') ?? '')
          if (tab !== 'skills' && tab !== 'mcp') continue
          let buttons = 0
          for (let next = 0; next < strip.children.length; next += 1) {
            if (tagIs(strip.children[next], 'BUTTON')) buttons += 1
          }
          if (buttons >= 2) return node
        }
      } catch {
        // A page without the panel simply has no root.
      }
      return null
    }

    function noteElement(text, isError) {
      const element = document.createElement('div')
      element.className = 'dsh-mcpc-note'
      if (isError === true) element.setAttribute('data-error', 'true')
      element.textContent = text
      return element
    }

    function switchElement(on, title, onFlip) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-mcpc-switch'
      button.setAttribute('role', 'switch')
      button.setAttribute('aria-checked', on ? 'true' : 'false')
      button.setAttribute('data-on', on ? 'true' : 'false')
      button.setAttribute('title', title)
      const knob = document.createElement('span')
      knob.className = 'dsh-mcpc-knob'
      button.appendChild(knob)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onFlip(on !== true)
      })
      return button
    }

    /** One tool row: name, description, weight, switch. */
    /** One tool row: name, description, weight, switch, expandable definition. */
    function toolRow(row, state) {
      const wrap = document.createElement('div')
      const element = document.createElement('div')
      element.className = 'dsh-mcpc-row'
      element.setAttribute('data-off', row.enabled === true ? 'false' : 'true')

      const text = document.createElement('button')
      text.type = 'button'
      text.className = 'dsh-mcpc-rowtext'
      const name = document.createElement('div')
      name.className = 'dsh-mcpc-rowname'
      name.textContent = row.name
      const sub = document.createElement('div')
      sub.className = 'dsh-mcpc-rowsub'
      const bits = []
      if (typeof row.description === 'string' && row.description.length > 0) bits.push(row.description)
      if (row.locked === true) bits.push('cannot be restricted')
      if (row.serverDisabled === true) bits.push('server off')
      sub.textContent = bits.join(' \u00b7 ')
      text.appendChild(name)
      if (sub.textContent !== '') text.appendChild(sub)

      const definition = typeof row.definition === 'string' ? row.definition : ''
      const pre = document.createElement('pre')
      pre.className = 'dsh-mcpc-pre'
      pre.textContent = definition
      pre.style.display = 'none'
      const canExpand = definition.length > 0
      if (canExpand) {
        text.title = 'Open the full definition sent to the model'
        text.setAttribute('aria-expanded', 'false')
        text.addEventListener('click', () => {
          const open = pre.style.display !== 'none'
          pre.style.display = open ? 'none' : 'block'
          text.setAttribute('aria-expanded', open ? 'false' : 'true')
        })
      } else {
        text.setAttribute('data-static', 'true')
      }

      const tokens = formatTokens(row.tokens)
      const tok = document.createElement('span')
      tok.className = 'dsh-mcpc-tok'
      tok.textContent = tokens
      tok.title = 'Weight of this schema in the context'

      element.appendChild(text)
      const toolOwner = typeof row.owner === 'string' ? row.owner : ''
      if (toolOwner !== '') {
        const tag = document.createElement('span')
        tag.className = 'dsh-mcpc-tag'
        tag.textContent = toolOwner
        tag.title = 'Plugin that registers this tool'
        element.appendChild(tag)
      }
      if (tokens !== '') element.appendChild(tok)
      const locked = row.locked === true || row.serverDisabled === true
      element.appendChild(switchElement(
        row.enabled === true,
        locked ? 'Locked' : 'Turn this tool on or off',
        (wanted) => { if (locked) return; state.flip('tools', 'toggleTool', row.name, wanted) },
      ))
      if (locked) element.lastChild.disabled = true
      wrap.appendChild(element)
      if (canExpand) wrap.appendChild(pre)
      return wrap
    }

    /** One prompt-section row: name, order, weight, switch, expandable text. */
    function promptRow(row, state) {
      const wrap = document.createElement('div')
      const element = document.createElement('div')
      element.className = 'dsh-mcpc-row'
      element.setAttribute('data-off', row.enabled === true ? 'false' : 'true')

      const text = document.createElement('button')
      text.type = 'button'
      text.className = 'dsh-mcpc-rowtext'
      const name = document.createElement('div')
      name.className = 'dsh-mcpc-rowname'
      name.textContent = row.name
      const sub = document.createElement('div')
      sub.className = 'dsh-mcpc-rowsub'
      const description = typeof row.description === 'string' ? row.description.trim() : ''
      if (description !== '') sub.textContent = description
      text.appendChild(name)
      if (description !== '') text.appendChild(sub)

      const details = []
      details.push(row.empty === true ? 'empty' : String(row.chars) + ' chars')
      if (row.dynamic === true) details.push('dynamic')
      element.title = row.name + ' \u00b7 ' + details.join(' \u00b7 ')

      const pre = document.createElement('pre')
      pre.className = 'dsh-mcpc-pre'
      const body = typeof row.text === 'string' ? row.text : ''
      pre.textContent = body
      pre.style.display = 'none'
      const canExpand = body.length > 0
      if (!canExpand) text.setAttribute('data-static', 'true')
      text.addEventListener('click', () => {
        if (!canExpand) return
        const open = pre.style.display !== 'none'
        pre.style.display = open ? 'none' : 'block'
        text.setAttribute('aria-expanded', open ? 'false' : 'true')
      })

      const tokens = formatTokens(row.tokens)
      const tok = document.createElement('span')
      tok.className = 'dsh-mcpc-tok'
      tok.textContent = tokens
      tok.title = 'Weight of this section in the system prompt'

      const order = document.createElement('span')
      order.className = 'dsh-mcpc-tag'
      order.textContent = 'order ' + String(row.order)
      order.title = 'Place of this section in the assembled prompt'

      element.appendChild(text)
      const sectionOwner = typeof row.owner === 'string' ? row.owner : ''
      if (sectionOwner !== '') {
        const tag = document.createElement('span')
        tag.className = 'dsh-mcpc-tag'
        tag.textContent = sectionOwner
        tag.title = 'Plugin that registers this section'
        element.appendChild(tag)
      }
      element.appendChild(order)
      if (tokens !== '') element.appendChild(tok)
      element.appendChild(switchElement(row.enabled === true, 'Turn this section on or off', (wanted) => {
        state.flip('prompts', 'togglePrompt', row.name, wanted)
      }))
      wrap.appendChild(element)
      if (canExpand) wrap.appendChild(pre)
      return wrap
    }

    function headElement(heading, caption, total) {
      const head = document.createElement('div')
      head.className = 'dsh-mcpc-head'
      const left = document.createElement('div')
      const title = document.createElement('div')
      title.className = 'dsh-mcpc-title'
      title.textContent = heading
      const note = document.createElement('p')
      note.className = 'dsh-mcpc-caption'
      note.textContent = caption
      left.appendChild(title)
      left.appendChild(note)
      head.appendChild(left)
      if (typeof total === 'string' && total.length > 0) {
        const right = document.createElement('div')
        right.className = 'dsh-mcpc-total'
        right.textContent = total
        head.appendChild(right)
      }
      return head
    }

    function paintTools(state, payload) {
      const body = state.body
      while (body.firstChild !== null) body.removeChild(body.firstChild)
      if (payload === null || payload === undefined) {
        body.appendChild(headElement(
          PAGE_TABS[0].heading,
          'Each switch removes the tool from the model in every conversation.',
          '',
        ))
        body.appendChild(noteElement('Loading\u2026', false))
        return
      }
      const summary = payload?.summary ?? {}
      const parts = []
      if (typeof summary.on === 'number') parts.push(summary.on + ' active')
      if (typeof summary.off === 'number' && summary.off > 0) parts.push(summary.off + ' off')
      const total = formatTokens(summary.tokens)
      if (total !== '') parts.push(total)
      body.appendChild(headElement(
        PAGE_TABS[0].heading,
        'Each switch removes the tool from the model in every conversation.',
        parts.join(' \u00b7 '),
      ))

      const rows = Array.isArray(payload?.tools) ? payload.tools : []
      if (rows.length === 0) {
        body.appendChild(noteElement(payload?.error !== undefined
          ? 'Erreur : ' + String(payload.error)
          : 'No harness tool is registered.', payload?.ok === false))
        return
      }
      const groups = Array.isArray(payload?.groups) ? payload.groups : []
      if (groups.length === 0) {
        for (const row of rows) body.appendChild(toolRow(row, state))
        return
      }
      for (const group of groups) {
        const section = document.createElement('div')
        section.className = 'dsh-mcpc-group'
        const head = document.createElement('div')
        head.className = 'dsh-mcpc-grouphead'
        const name = document.createElement('span')
        name.className = 'dsh-mcpc-groupname'
        name.textContent = String(group.name ?? '')
        const meta = document.createElement('span')
        meta.className = 'dsh-mcpc-groupmeta'
        const bits = [String(group.on ?? 0) + '/' + String(group.count ?? 0)]
        const groupTokens = formatTokens(group.tokens)
        if (groupTokens !== '') bits.push(groupTokens)
        if (group.serverDisabled === true) bits.push('server off')
        meta.textContent = bits.join(' \u00b7 ')
        head.appendChild(name)
        head.appendChild(meta)
        section.appendChild(head)
        for (const row of rows) if (row?.group === group.name) section.appendChild(toolRow(row, state))
        body.appendChild(section)
      }
    }

    function paintPrompts(state, payload) {
      const body = state.body
      while (body.firstChild !== null) body.removeChild(body.firstChild)
      if (payload === null || payload === undefined) {
        body.appendChild(headElement(
          PAGE_TABS[1].heading,
          'Each switch removes the section from the system prompt in every conversation.',
          '',
        ))
        body.appendChild(noteElement('Loading\u2026', false))
        return
      }
      const summary = payload?.summary ?? {}
      const parts = []
      if (typeof summary.on === 'number') parts.push(summary.on + (summary.on === 1 ? ' active section' : ' active sections'))
      if (typeof summary.off === 'number' && summary.off > 0) parts.push(summary.off + ' off')
      const total = formatTokens(summary.tokens)
      if (total !== '') parts.push(total)
      body.appendChild(headElement(
        PAGE_TABS[1].heading,
        'Each switch removes the section from the system prompt in every conversation.',
        parts.join(' \u00b7 '),
      ))

      const rows = Array.isArray(payload?.prompts) ? payload.prompts : []
      if (rows.length === 0) {
        const message = payload?.ok === false
          ? 'Erreur : ' + String(payload.error ?? 'registre indisponible')
          : 'The system prompt registry is not available.'
        body.appendChild(noteElement(message, payload?.ok === false))
        return
      }
      const section = document.createElement('div')
      section.className = 'dsh-mcpc-group'
      const head = document.createElement('div')
      head.className = 'dsh-mcpc-grouphead'
      const name = document.createElement('span')
      name.className = 'dsh-mcpc-groupname'
      name.textContent = 'Assembly order'
      const meta = document.createElement('span')
      meta.className = 'dsh-mcpc-groupmeta'
      meta.textContent = String(rows.length) + ' sections'
      head.appendChild(name)
      head.appendChild(meta)
      section.appendChild(head)
      for (const row of rows) section.appendChild(promptRow(row, state))
      body.appendChild(section)
    }

    function paintPage(state, kind) {
      try {
        const payload = state.payload[kind]
        if (kind === 'tools') paintTools(state, payload)
        else paintPrompts(state, payload)
        state.body.setAttribute('data-mcpc-ready', 'true')
      } catch (error) {
        report('page-paint-error', String(error?.message ?? error))
      }
    }

    function loadPage(state, kind, force) {
      if (state.loading[kind] === true) return
      if (force !== true && state.payload[kind] !== null) return
      state.loading[kind] = true
      const url = ENDPOINT + '?view=' + kind + '&client=' + CLIENT_VERSION
      fetchJson(url)
        .then((payload) => {
          state.loading[kind] = false
          if (payload !== null && typeof payload === 'object') state.payload[kind] = payload
          else state.payload[kind] = { ok: false, error: 'unreadable response' }
          if (state.tab === kind) paintPage(state, kind)
        })
        .catch((error) => {
          state.loading[kind] = false
          state.payload[kind] = { ok: false, error: String(error?.message ?? error) }
          if (state.tab === kind) paintPage(state, kind)
          report('page-load-error', kind + ': ' + String(error?.message ?? error))
        })
    }

    /** Show or hide the panel's own content while one of our tabs is active. */
    function maskOwnContent(state, mask) {
      const kids = state.root.children
      for (let index = 2; index < kids.length; index += 1) {
        const kid = kids[index]
        if (kid === null || kid === undefined) continue
        if (typeof kid.hasAttribute === 'function' && kid.hasAttribute('data-mcpc-body')) continue
        try {
          if (mask === true) {
            if (kid.style.display !== 'none') {
              kid.setAttribute('data-mcpc-masked', 'true')
              kid.style.display = 'none'
            }
          } else if (kid.hasAttribute('data-mcpc-masked') === true) {
            kid.removeAttribute('data-mcpc-masked')
            kid.style.removeProperty('display')
          }
        } catch {
          // One stubborn node must not leave the page blank.
        }
      }
    }

    /**
     * Keep the tab body inside the viewport so its own list can scroll.
     *
     * The panel page may be as tall as its content and clipped by its own
     * `overflow:hidden`: a long list would then be cut with no scrollbar. Sizing
     * the body to the space left under the tab strip gives it a definite height,
     * which is what turns `overflow-y:auto` into a real scroll.
     */
    function fitBody(state) {
      if (state === null || state === undefined || state.tab === null) return
      try {
        const viewport = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
        if (viewport <= 0) return
        const rect = state.body.getBoundingClientRect()
        const available = Math.max(180, Math.floor(viewport - rect.top - 16))
        const current = Number.parseInt(state.body.style.maxHeight, 10)
        if (Number.isFinite(current) && Math.abs(current - available) < 3) return
        state.body.style.maxHeight = available + 'px'
        if (state.reported !== true) {
          state.reported = true
          const rootRect = state.root.getBoundingClientRect()
          report('page-metrics', 'vh=' + viewport + ' top=' + Math.round(rect.top)
            + ' avail=' + available + ' scroll=' + state.body.scrollHeight
            + ' client=' + state.body.clientHeight + ' rootH=' + Math.round(rootRect.height)
            + ' overflow=' + String(state.body.style.overflowY))
        }
      } catch {
        // A page without layout still renders, just without the cap.
      }
    }

    function selectTab(state, id) {
      if (state === null) return
      state.tab = id
      for (const [key, button] of state.buttons) {
        button.setAttribute('data-active', key === id ? 'true' : 'false')
        button.setAttribute('aria-pressed', key === id ? 'true' : 'false')
      }
      state.root.setAttribute('data-mcpc-active', '1')
      state.body.style.display = 'flex'
      state.body.setAttribute('data-mcpc-view', id)
      maskOwnContent(state, true)
      fitBody(state)
      // The body is a single subtree shared by both views: switching tabs must
      // repaint it even when that view was already loaded.
      paintPage(state, id)
      loadPage(state, id, false)
    }

    function clearTab(state) {
      if (state === null) return
      state.tab = null
      for (const [, button] of state.buttons) {
        button.setAttribute('data-active', 'false')
        button.setAttribute('aria-pressed', 'false')
      }
      state.root.removeAttribute('data-mcpc-active')
      state.body.style.display = 'none'
      maskOwnContent(state, false)
    }

    function flipPage(state, kind, param, name, wanted) {
      const url = ENDPOINT + '?view=' + kind + '&' + param + '=' + encodeURIComponent(name)
        + '&enabled=' + (wanted === true ? 'true' : 'false') + '&client=' + CLIENT_VERSION
      fetchJson(url)
        .then((payload) => {
          if (payload === null || typeof payload !== 'object') return
          state.payload[kind] = payload
          if (state.tab === kind) paintPage(state, kind)
          if (payload.ok !== true) report('page-toggle-error', String(payload.error ?? 'inconnu'))
          else report('page-toggle', kind + ' ' + name + '=' + String(wanted === true))
        })
        .catch((error) => { report('page-toggle-error', String(error?.message ?? error)) })
    }

    /**
     * Drop the tabs and body a previous module instance left in the page.
     *
     * A client bundle reload replaces the module but not the DOM it built, so
     * decoration must be idempotent across instances instead of stacking.
     */
    function cleanPrevious(root) {
      try {
        const strip = childBy(root, (kid) => kid?.getAttribute?.('role') === 'tablist')
        if (strip !== null) {
          for (const kid of Array.from(strip.children)) {
            if (typeof kid.hasAttribute === 'function' && kid.hasAttribute('data-mcpc-tab')) strip.removeChild(kid)
          }
        }
        for (const kid of Array.from(root.children)) {
          if (typeof kid.hasAttribute === 'function' && kid.hasAttribute('data-mcpc-body')) root.removeChild(kid)
        }
        root.removeAttribute('data-mcpc-active')
        for (const kid of Array.from(root.children)) {
          if (kid.hasAttribute?.('data-mcpc-masked') === true) {
            kid.removeAttribute('data-mcpc-masked')
            kid.style.removeProperty('display')
          }
        }
      } catch {
        // A half-cleaned page is still better than a duplicated one.
      }
    }

    /** Build our tabs and body inside the panel page; returns the state. */
    function decoratePage(root) {
      const strip = childBy(root, (kid) => kid?.getAttribute?.('role') === 'tablist')
      if (strip === null) return null
      cleanPrevious(root)
      const own = []
      for (let index = 0; index < strip.children.length; index += 1) {
        if (tagIs(strip.children[index], 'BUTTON')) own.push(strip.children[index])
      }
      if (own.length === 0) return null

      const buttons = new Map()
      const prototype = own[own.length - 1]
      for (const tab of PAGE_TABS) {
        let button
        try {
          button = prototype.cloneNode(true)
        } catch {
          button = null
        }
        if (button === null) {
          button = document.createElement('button')
          button.className = prototype.getAttribute('className') ?? prototype.className ?? ''
          button.type = 'button'
        }
        button.textContent = tab.label
        button.setAttribute('data-mcpc-tab', tab.id)
        button.setAttribute('data-active', 'false')
        button.setAttribute('aria-pressed', 'false')
        button.setAttribute('title', tab.heading)
        strip.appendChild(button)
        buttons.set(tab.id, button)
      }

      const body = document.createElement('div')
      body.className = 'dsh-mcpc-body'
      body.setAttribute('data-mcpc-body', '1')
      body.style.display = 'none'
      root.appendChild(body)

      const state = {
        root,
        strip,
        body,
        buttons,
        tab: null,
        payload: { tools: null, prompts: null },
        loading: { tools: false, prompts: false },
        flip: (kind, param, name, wanted) => flipPage(state, kind, param, name, wanted),
        observer: null,
        timer: null,
        dispose: null,
      }

      for (const tab of PAGE_TABS) {
        buttons.get(tab.id).addEventListener('click', (event) => {
          event.preventDefault()
          selectTab(state, tab.id)
        })
      }
      // The user going back to one of the panel's own tabs must reveal its
      // content again; the listener runs in the capture phase so it wins
      // against React's own click handling.
      const onStripClick = (event) => {
        let node = event.target
        while (node !== null && node !== undefined && node !== strip) {
          if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-mcpc-tab')) return
          node = node.parentNode
        }
        if (state.tab !== null) clearTab(state)
      }
      strip.addEventListener('click', onStripClick, true)

      const repair = () => {
        if (state.tab === null) return
        if (state.body.style.display !== 'flex') state.body.style.display = 'flex'
        fitBody(state)
        maskOwnContent(state, true)
        if (state.body.childNodes.length === 0 && state.payload[state.tab] === null) paintPage(state, state.tab)
      }
      const onResize = () => { try { fitBody(state) } catch { /* layout not ready */ } }
      try { window.addEventListener('resize', onResize) } catch { /* no window */ }
      try {
        if (typeof MutationObserver === 'function') {
          state.observer = new MutationObserver(() => {
            try { repair() } catch { /* a repair pass must never throw into React */ }
          })
          state.observer.observe(root, { childList: true, subtree: false })
        }
      } catch {
        state.observer = null
      }
      // Belt and braces: content swapped by React is hidden again within a
      // quarter second even if the observer missed the mutation.
      state.timer = setInterval(() => {
        try {
          if (document.contains?.(root) === false) { disposePage(state); return }
          // A reloaded bundle replaces the module but keeps the page: the old
          // body is detached by the new instance, so this one stands down.
          if (state.body.isConnected === false) { disposePage(state); return }
          repair()
        } catch { /* ignore */ }
      }, 250)

      state.dispose = () => {
        state.tab = null
        try { strip.removeEventListener('click', onStripClick, true) } catch { /* already gone */ }
        try { window.removeEventListener('resize', onResize) } catch { /* no window */ }
        try { state.observer?.disconnect?.() } catch { /* already gone */ }
        if (state.timer !== null) clearInterval(state.timer)
        state.timer = null
        try { body.remove() } catch { if (body.parentNode !== null) body.parentNode.removeChild(body) }
        for (const [, button] of buttons) {
          try { button.remove() } catch { /* already gone */ }
        }
        try { root.removeAttribute('data-mcpc-active') } catch { /* ignore */ }
        maskOwnContent(state, false)
      }
      return state
    }

    function disposePage(state) {
      if (state === null) return
      try { state.dispose?.() } catch { /* already disposed */ }
      if (PAGE === state) PAGE = null
    }

    /**
     * Keep the page decorated while the panel is open. A new page element
     * (panel reopened, route changed) replaces the previous decoration.
     */
    function installPageTabs() {
      let root = null
      try { root = findPageRoot() } catch { root = null }
      if (PAGE !== null && (root === null || root !== PAGE.root || pageAlive(PAGE) === false)) {
        disposePage(PAGE)
      }
      if (root === null || PAGE !== null) return
      ensurePageStyles()
      const state = decoratePage(root)
      if (state !== null) {
        PAGE = state
        report('page-tabs', 'tabs installed')
      }
    }

    function pageAlive(state) {
      try {
        if (state?.root?.isConnected === true) return true
        if (typeof document.contains === 'function') return document.contains(state.root) === true
      } catch {
        // Unknown: assume alive and let the next pass decide.
        return true
      }
      return true
    }

    return {
      inject: ['remote'],
      apply(ctx) {
        // Nothing here may take the page down: every step is guarded, and a
        // failure simply leaves the chip or the panel decoration absent.
        report('apply', 'v=' + CLIENT_VERSION)
        try {
          refresh(true)
        } catch {
          // The route is unavailable; the chip will report it when opened.
        }
        try {
          installChip(ctx)
        } catch (error) {
          report('chip-slot-error', String(error?.message ?? error))
        }
        try {
          installPageTabs()
        } catch (error) {
          report('page-tabs-error', String(error?.message ?? error))
        }
        // The panel page exists only while its sidebar row is open, so the
        // decoration is re-checked often: the pass is one query when the page
        // is closed and idle work when it is open.
        const pageTimer = setInterval(() => {
          try { installPageTabs() } catch { /* one failed pass must not stop the decorator */ }
        }, 300)
        if (typeof pageTimer?.unref === 'function') pageTimer.unref()
        try {
          ctx.effect(() => () => clearInterval(pageTimer), 'dsh-mcp-companion: page tabs')
        } catch {
          // No effect scope: the interval stays for the life of the page.
        }
        // The namespace appears when the owning panel mounts it; a light poll
        // picks it up without depending on plugin activation order.
        const timer = setInterval(() => {
          try {
            install(ctx)
            refresh(false)
          } catch {
            // A single failed pass must not stop the decorator.
          }
        }, 1000)
        if (typeof timer?.unref === 'function') timer.unref()
        try {
          ctx.effect(() => () => clearInterval(timer), 'dsh-mcp-companion: panel decorator')
        } catch {
          // No effect scope: the interval stays for the life of the page.
        }
      },
    }
  },
})
