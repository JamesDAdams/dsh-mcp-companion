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
    const CLIENT_VERSION = '1.1.7'
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
      return server !== undefined && typeof server.provider === 'string' ? server.provider : 'un autre plugin'
    }

    const messageOf = (name) =>
      name + ' est fourni par ' + ownerOf(name)
      + ' : il n\u2019a pas de ligne @deepseek-ai/dsh-mcp-client dans cordis.patch.yml. '
      + 'Le panneau l\u2019affiche en lecture seule ; configurez-le dans les r\u00e9glages de ce plugin.'

    const rawTextOf = (name) =>
      '# ' + name + ' \u2014 serveur fourni par ' + ownerOf(name) + '\n'
      + '#\n'
      + '# Ce serveur est mont\u00e9 par le plugin lui-m\u00eame (ctx.plugin(@deepseek-ai/dsh-mcp-client)),\n'
      + '# donc il n\u2019existe volontairement aucune ligne @deepseek-ai/dsh-mcp-client ici.\n'
      + '# L\u2019ajouter cr\u00e9erait un second serveur. Utilisez les r\u00e9glages du plugin.\n'

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
            return { ok: false, error: { code: 'toggle-failed', message: 'Serveur introuvable apres bascule : ' + name } }
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
      parts.push(count + (count === 1 ? ' outil' : ' outils'))
      if (server?.source === 'bridge') parts.push('ressources MCP')
      else if (server?.source === 'profile') parts.push('d\u00e9clar\u00e9')
      else if (typeof server?.provider === 'string' && server.provider.length > 0) parts.push(server.provider)
      if (server?.override === 'on') parts.push('activ\u00e9 ici')
      else if (server?.override === 'off') parts.push('d\u00e9sactiv\u00e9 ici')
      else if (server?.globalEnabled === false) parts.push('d\u00e9sactiv\u00e9 partout')
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
      button.title = 'MCP de cette conversation'
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
        badge.title = 'Poids des sch\u00e9mas de ce serveur dans le contexte'

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
        headLabel.textContent = 'MCP de cette conversation'
        head.appendChild(headLabel)
        const activeTokens = rows.reduce((total, server) => total
          + (server?.enabled === false ? 0 : (typeof server?.tokens === 'number' ? server.tokens : 0)), 0)
        if (activeTokens > 0) {
          const headTotal = document.createElement('span')
          headTotal.className = 'dsh-mcp-head-total'
          headTotal.textContent = formatTokens(activeTokens)
          headTotal.title = 'Poids total des outils MCP actifs dans cette conversation'
          head.appendChild(headTotal)
        }

        const list = document.createElement('div')
        list.className = 'dsh-mcp-list'
        if (payload === null) list.appendChild(note('Chargement\u2026'))
        else if (rows.length === 0) list.appendChild(note('Aucun serveur MCP actif.'))
        else for (const server of rows) list.appendChild(rowElement(server))

        const foot = document.createElement('div')
        foot.className = 'dsh-mcp-foot'
        foot.textContent = hasSession
          ? 'Ce r\u00e9glage ne vaut que pour cette conversation.'
          : 'Ouvre une conversation pour r\u00e9gler ses MCP.'

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
        menu.setAttribute('aria-label', 'MCP de cette conversation')
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
          label: 'MCP de cette conversation',
        }, ConversationMcpChip)
        slots.inject(CHIP_SLOT, register)
        report('chip-slot', CHIP_SLOT)
        return true
      } catch (error) {
        report('chip-slot-error', String(error?.message ?? error))
        return false
      }
    }

    return {
      inject: ['remote'],
      apply(ctx) {
        // Nothing here may take the page down: every step is guarded, and a
        // failure simply leaves the chip or the panel decoration absent.
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
