/**
 * Client half of @local/dsh-customizer.
 *
 * It adds nothing to the UI. A server another plugin mounts itself - the
 * `wincu` Windows computer-use server is created with
 * `ctx.plugin(bridge, bridgeConfig(...))` inside dsh-computer-use-win, so it
 * has no `@deepseek-ai/dsh-mcp-client` row in cordis.patch.yml - cannot appear
 * in the Skill/MCP panel's list, which is built from that file. Rather than
 * adding a second tab or editing the panel, this module decorates the panel's
 * Remote results at runtime:
 *
 *   - `list` and `reload` gain one read-only entry per live server the Host
 *     inventory route reports with source "plugin", so the panel's own cards
 *     render them (its Refresh button calls `reload`);
 *   - `test` answers from the live tool registry instead of a missing row;
 *   - `readRaw` explains why no YAML row exists;
 *   - save / setEnabled / removeServer / writeRaw are refused with a readable
 *     reason, because those servers belong to another plugin.
 *
 * The hook is the Remote service class's `invoke`, patched once on the
 * prototype: every generated namespace method funnels its envelope through it,
 * whatever the panel calls its namespace and every time it re-mounts.
 * Augmentation only happens for results shaped like the panel's MCP list, and
 * guards only for a server name the Host reports as plugin-owned, so other
 * namespaces are untouched.
 *
 * This file stays pure ASCII on purpose: the Client bundle builder decodes
 * plugin sources as Latin-1, so non-ASCII literals must be escaped.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-companion',
  factory() {
    const ENDPOINT = '/local-dsh-customizer/mcp-servers'
    const CLIENT_VERSION = '1.0.0'

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

    function testOf(name) {      return refresh(false).then((payload) => {
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
      return fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((response) => response.json())
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

    return {
      inject: ['remote'],
      apply(ctx) {
        refresh(true)
        // The namespace appears when the owning panel mounts it; a light poll
        // picks it up without depending on plugin activation order.
        const timer = setInterval(() => {
          install(ctx)
          refresh(false)
        }, 1000)
        if (typeof timer?.unref === 'function') timer.unref()
        ctx.effect(() => () => clearInterval(timer), 'dsh-customizer: mcp list decorator')
      },
    }
  },
})
