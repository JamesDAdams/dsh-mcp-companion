/**
 * Host half of @local/dsh-customizer.
 *
 * First module: a complete MCP inventory.
 *
 * `dsh-skill-mcp-panel` lists only the `@deepseek-ai/dsh-mcp-client` rows that
 * live in the profile's `cordis.patch.yml`. A server that another plugin mounts
 * itself — the `wincu` Windows computer-use server is created with
 * `ctx.plugin(bridge, bridgeConfig(…))` inside `dsh-computer-use-win`, so it has
 * no patch row at all — can therefore never appear in that list.
 *
 * This route answers with what actually exists at runtime instead:
 *
 *   GET /local-dsh-customizer/mcp-servers
 *
 * It joins two read-only sources:
 *   1. the live loader entries (`ctx.loader.entries()`), i.e. every declared
 *      `@deepseek-ai/dsh-mcp-client` row plus the other plugin entries, with
 *      their id, package name, config, disabled flag and fiber phase;
 *   2. the tool schemas the Host registry currently exposes, whose public names
 *      follow `mcp__<serverName>__<originalToolName>` for every MCP server,
 *      whichever plugin mounted it.
 *
 * A server present in (2) but not in (1) is exactly the case the other panel
 * cannot show; it is reported with `source: "plugin"`.
 *
 * Nothing is written, no MCP server is started, and no config value is
 * evaluated: the route only reads strings and numbers it can see.
 */

const ROUTE = '/local-dsh-customizer/mcp-servers'
import { attachDisableController, loadDisabled, saveDisabled } from './filter.js'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** The MCP resource bridge's shared tools, exposed by @deepseek-ai/dsh-mcp-resources. */
const RESOURCE_BRIDGE_PACKAGE = '@deepseek-ai/dsh-mcp-resources'
const RESOURCE_BRIDGE_NAME = 'mcp-resource-servers'
const RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

/** Cordis fiber phases, as the loader numbers them. */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

const MAX_TOOLS = 200

/** Last Client bundle that asked for the inventory (diagnostics only). */
let LAST_CLIENT = null

function asString(value, max = 400) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length > max ? text.slice(0, max) + '…' : text
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a Host service without ever throwing when it is absent. */
function serviceOf(ctx, name) {
  try {
    const direct = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (direct !== undefined && direct !== null) return direct
  } catch { /* absent service */ }
  try {
    const viaProperty = ctx[name]
    if (viaProperty !== undefined && viaProperty !== null) return viaProperty
  } catch { /* throwing accessor */ }
  return undefined
}

function readEntry(entry) {
  const options = entry !== null && typeof entry === 'object' ? entry.options : undefined
  const config = options !== null && typeof options === 'object' && options.config !== null && typeof options.config === 'object'
    ? options.config
    : {}
  let phase = null
  try {
    phase = FIBER_PHASE[entry?.fiber?.state] ?? null
  } catch { /* no fiber */ }
  return {
    id: asString(entry?.id) ?? asString(options?.id),
    name: asString(options?.name) ?? asString(entry?.name),
    config,
    disabled: entry?.disabled === true || options?.disabled === true || config?.disabled === true,
    phase,
  }
}

function readEntries(ctx) {
  const loader = serviceOf(ctx, 'loader')
  const rows = []
  let available = false
  try {
    if (loader !== undefined && typeof loader.entries === 'function') {
      available = true
      for (const entry of loader.entries()) {
        try {
          rows.push(readEntry(entry))
        } catch { /* one broken entry must not hide the others */ }
      }
    }
  } catch { /* loader not readable */ }
  return { available, rows }
}

function readSchemas(ctx) {
  const tools = serviceOf(ctx, 'tools')
  const rows = []
  let available = false
  for (const method of ['schemas', 'definitions']) {
    try {
      if (tools === undefined || typeof tools[method] !== 'function') continue
      const list = tools[method]()
      if (!Array.isArray(list)) continue
      available = true
      for (const item of list) {
        if (item !== null && typeof item === 'object' && typeof item.name === 'string') rows.push(item)
      }
      if (rows.length > 0) break
    } catch { /* try the next shape */ }
  }
  return { available, rows }
}

/**
 * Split `mcp__<server>__<tool>` into the server name. A declared server name
 * wins (longest first) because server names may themselves contain `_`.
 */
function serverOfTool(toolName, declaredNames) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return undefined
  for (const name of declaredNames) {
    if (toolName.startsWith('mcp__' + name + '__')) return name
  }
  const rest = toolName.slice('mcp__'.length)
  const split = rest.indexOf('__')
  if (split <= 0) return undefined
  return rest.slice(0, split)
}

function transportOf(config) {
  const transport = asString(config?.transport)
  return transport ?? (asString(config?.url) !== undefined ? 'http' : 'stdio')
}

function buildDeclaredServer(entry) {
  const config = entry.config
  const serverName = asString(config?.serverName)
  if (serverName === undefined) return undefined
  const args = Array.isArray(config?.args)
    ? config.args.filter((value) => typeof value === 'string').slice(0, 12)
    : undefined
  return {
    name: serverName,
    source: 'profile',
    entryId: entry.id ?? null,
    entryName: entry.name ?? null,
    enabled: entry.disabled !== true,
    disabled: entry.disabled === true,
    phase: entry.phase,
    transport: transportOf(config),
    command: asString(config?.command, 200),
    args,
    url: asString(config?.url, 300),
    active: false,
    toolCount: 0,
    tools: [],
  }
}

function inventory(ctx, disabled) {
  const off = disabled instanceof Set ? disabled : new Set(Array.isArray(disabled) ? disabled : [])
  const { available: loaderAvailable, rows: entries } = readEntries(ctx)
  const { available: toolsAvailable, rows: schemas } = readSchemas(ctx)

  const declaredEntries = []
  const adapters = []
  for (const entry of entries) {
    if (entry.name === MCP_CLIENT_PACKAGE) {
      declaredEntries.push(entry)
      continue
    }
    // A non-mcp-client row that names itself after an MCP adapter is the
    // likely owner of runtime-only servers such as wincu.
    const id = entry.id ?? ''
    const name = entry.name ?? ''
    if (name.length === 0) continue
    if (/^@local\//i.test(name)) continue
    if (/^dsh-skill-mcp-panel/i.test(name)) continue
    if (/^mcp-/i.test(id) || /computer-use/i.test(name) || /computer-use/i.test(id)) {
      adapters.push({ entryId: entry.id ?? null, name })
    }
  }

  const servers = new Map()
  const declaredNames = []
  for (const entry of declaredEntries) {
    const server = buildDeclaredServer(entry)
    if (server === undefined) continue
    declaredNames.push(server.name)
    if (!servers.has(server.name)) servers.set(server.name, server)
  }
  declaredNames.sort((a, b) => b.length - a.length)

  let schemaCount = 0
  for (const schema of schemas) {
    const serverName = serverOfTool(schema.name, declaredNames)
    if (serverName === undefined) continue
    let row = servers.get(serverName)
    if (row === undefined) {
      row = {
        name: serverName,
        source: 'plugin',
        entryId: null,
        entryName: null,
        enabled: true,
        disabled: false,
        phase: null,
        transport: null,
        command: null,
        args: null,
        url: null,
        active: false,
        toolCount: 0,
        tools: [],
      }
      servers.set(serverName, row)
    }
    row.toolCount += 1
    if (row.tools.length < MAX_TOOLS) {
      row.tools.push({
        name: schema.name,
        description: asString(schema.description, 280) ?? '',
      })
      schemaCount += 1
    }
  }

  // The MCP resource bridge is a Host plugin, not a server: it contributes the
  // three shared resource tools (list resources, list templates, read resource)
  // that the model uses through `mcpResources`. Its tools carry no
  // `mcp__<server>__` prefix, so the panel never shows them; add one read-only
  // entry so they are visible and filterable there.
  const bridgeEntry = entries.find((entry) => entry.name === RESOURCE_BRIDGE_PACKAGE && entry.disabled !== true)
  if (bridgeEntry !== undefined) {
    const resourceTools = schemas
      .filter((schema) => RESOURCE_TOOLS.includes(schema.name))
      .map((schema) => ({
        name: schema.name,
        description: asString(schema.description, 280) ?? '',
      }))
    servers.set(RESOURCE_BRIDGE_NAME, {
      name: RESOURCE_BRIDGE_NAME,
      source: 'bridge',
      entryId: bridgeEntry.id ?? null,
      entryName: bridgeEntry.name ?? null,
      enabled: true,
      disabled: false,
      phase: bridgeEntry.phase ?? null,
      transport: null,
      command: null,
      args: null,
      url: null,
      active: resourceTools.length > 0,
      toolCount: resourceTools.length,
      tools: resourceTools,
      provider: RESOURCE_BRIDGE_PACKAGE,
    })
  }

  const provider = adapters.length === 1 ? adapters[0].name : undefined
  const rows = [...servers.values()].map((row) => {
    row.active = row.toolCount > 0
    if (row.source === 'plugin' && provider !== undefined) row.provider = provider
    if (row.source === 'plugin' || row.source === 'bridge') {
      row.toggleable = true
      row.enabled = !off.has(row.name)
      row.disabled = !row.enabled
    }
    return row
  })
  const rank = (row) => (row.source === 'plugin' ? 0 : row.source === 'bridge' ? 1 : 2)
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const summary = {
    servers: rows.length,
    active: rows.filter((row) => row.active && row.enabled !== false).length,
    tools: rows.reduce((total, row) => total + row.toolCount, 0),
    plugin: rows.filter((row) => row.source === 'plugin').length,
    bridge: rows.filter((row) => row.source === 'bridge').length,
    declared: rows.filter((row) => row.source === 'profile').length,
    disabled: rows.filter((row) => row.enabled === false).length,
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary,
    servers: rows,
    adapters,
    diagnostics: {
      loaderAvailable,
      toolsAvailable,
      loaderEntries: entries.length,
      client: LAST_CLIENT,
      toolSchemas: schemaCount,
      mcpEntries: entries
        .filter((entry) => entry.id !== null && entry.id !== undefined && /mcp/i.test(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.name ?? null,
          disabled: entry.disabled === true,
          phase: entry.phase ?? null,
        })),
    },
  }
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try { res.end() } catch { /* socket already gone */ }
  }
}

export const inject = ['webServer']

/**
 * Public tool names owned by the disabled servers, evaluated right before a
 * restriction is applied so late-connecting MCP tools are caught too.
 */
function denyNames(ctx, off) {
  if (off.size === 0) return []
  const names = new Set()
  const wanted = new Set(off)
  if (wanted.has(RESOURCE_BRIDGE_NAME)) {
    for (const name of RESOURCE_TOOLS) names.add(name)
    wanted.delete(RESOURCE_BRIDGE_NAME)
  }
  if (wanted.size === 0) return [...names]
  const { rows } = readSchemas(ctx)
  for (const schema of rows) {
    if (typeof schema?.name !== 'string') continue
    for (const server of wanted) {
      if (schema.name.startsWith('mcp__' + server + '__')) {
        names.add(schema.name)
        break
      }
    }
  }
  return [...names]
}

export function apply(ctx) {
  const disabled = new Set(loadDisabled())

  let controller
  try {
    controller = attachDisableController(ctx, () => denyNames(ctx, disabled))
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try { controller?.dispose() } catch { /* already disposed */ }
      })
    }
  } catch (error) {
    try { ctx.logger?.warn?.('dsh-customizer: MCP disable controller unavailable: %s', String(error?.message ?? error)) } catch { /* no logger */ }
  }

  const register = () => {
    const webServer = serviceOf(ctx, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      throw new Error('DSH exposes no webServer service in this profile')
    }
    return webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        try {
          const url = new URL(String(req?.url ?? ROUTE), 'http://localhost')
          const clientVersion = url.searchParams.get('client')
          if (typeof clientVersion === 'string' && clientVersion.length > 0) {
            LAST_CLIENT = { version: clientVersion.slice(0, 40), at: new Date().toISOString() }
          }
          const toggle = method === 'GET' ? url.searchParams.get('toggle') : null
          if (toggle !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const before = inventory(ctx, disabled)
            const target = before.servers.find((row) => row.name === toggle && row.toggleable === true)
            if (target === undefined) {
              sendJson(res, 400, { ok: false, error: 'unknown toggle target: ' + toggle })
              return
            }
            if (wanted) disabled.delete(toggle)
            else disabled.add(toggle)
            try {
              await saveDisabled([...disabled])
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the disabled list: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            controller?.setChanged()
          }
          const payload = inventory(ctx, disabled)
          if (method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end()
            return
          }
          sendJson(res, 200, payload)
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: String(error?.message ?? error).slice(0, 300),
            summary: { servers: 0, active: 0, tools: 0, plugin: 0, declared: 0 },
            servers: [],
            adapters: [],
            diagnostics: {},
          })
        }
      },
    })
  }

  let dispose
  try {
    dispose = typeof ctx.effect === 'function' ? ctx.effect(register) : register()
  } catch (error) {
    // Never take the Host down over a missing route seat.
    try { ctx.logger?.warn?.('dsh-customizer: inventory route unavailable: %s', String(error?.message ?? error)) } catch { /* no logger */ }
    return undefined
  }
  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch { /* already disposed */ }
    try { controller?.dispose() } catch { /* already disposed */ }
  }
}
