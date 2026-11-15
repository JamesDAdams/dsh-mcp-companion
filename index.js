/** Group used for rows no plugin claims. */
const UNATTRIBUTED = 'harness'

/** Order rows by group (plugin name, unclaimed last), then by row name/order. */
function compareGroups(a, b) {
  const rank = (group) => (group === UNATTRIBUTED ? 1 : 0)
  if (rank(a.group) !== rank(b.group)) return rank(a.group) - rank(b.group)
  if (a.group !== b.group) return a.group.localeCompare(b.group)
  const keyA = typeof a.sortKey === 'number' ? a.sortKey : 0
  const keyB = typeof b.sortKey === 'number' ? b.sortKey : 0
  if (keyA !== keyB) return keyA - keyB
  return String(a.name).localeCompare(String(b.name))
}

/** Group counters, built from rows already sorted by group. */
function groupsOf(rows) {
  const groups = []
  for (const row of rows) {
    let group = groups[groups.length - 1]
    if (group === undefined || group.name !== row.group) {
      group = { name: row.group, count: 0, on: 0, tokens: 0 }
      groups.push(group)
    }
    group.count += 1
    if (row.enabled !== false) {
      group.on += 1
      group.tokens += row.tokens
    }
  }
  return groups
}

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
 *   GET /local-dsh-customizer/mcp-servers            -> MCP inventory
 *   GET /local-dsh-customizer/mcp-servers?view=tools -> every public tool
 *   GET /local-dsh-customizer/mcp-servers?view=prompts -> every system-prompt
 *                                                       section
 *   GET …&toggleTool=<name>&enabled=true|false       -> switch one tool
 *   GET …&togglePrompt=<name>&enabled=true|false     -> switch one section
 *
 * The two views feed the extra tabs this plugin adds to the Skill/MCP page; the
 * toggles are profile-wide and flow back through the same per-Agent restriction
 * (tools) and empty-shadow (prompt sections) mechanism the MCP switches use.
 *
 * The inventory joins two read-only sources:
 *
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
 * Reading never starts an MCP server and never evaluates a config value: the
 * views only report strings and numbers the Host can already see. The only
 * writes are this plugin's own switches, recorded in
 * `<dshHome>/dsh-customizer/state.json`.
 */

const ROUTE = '/local-dsh-customizer/mcp-servers'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { attachDisableController, dshHome, loadState, saveState } from './filter.js'
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
/** Longest prompt-section body the page tab receives; the rest is dropped. */
const PROMPT_TEXT_LIMIT = 2500
/** Longest tool definition the page tab receives; the rest is dropped. */
const TOOL_TEXT_LIMIT = 4000

/** Last Client bundle that asked for the inventory (diagnostics only). */
let LAST_CLIENT = null
/** Recent Client reports (slot registration, errors); newest first. */
const CLIENT_DIAG = []
const MAX_DIAG = 24

function pushDiag(kind, text) {
  try {
    CLIENT_DIAG.unshift({ kind: String(kind).slice(0, 40), text: String(text ?? '').slice(0, 300), at: new Date().toISOString() })
    while (CLIENT_DIAG.length > MAX_DIAG) CLIENT_DIAG.pop()
  } catch { /* never fail a request over diagnostics */ }
}

function asString(value, max = 400) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  return text.length > max ? text.slice(0, max) + '…' : text
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Same heuristic the harness' own token meter uses (dsh-token-meter/estimate). */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

/** Heuristic size of one server's tool schemas, as the model receives them. */
function estimateToolTokens(list) {
  if (!Array.isArray(list) || list.length === 0) return 0
  try {
    return Math.ceil(JSON.stringify(list).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  } catch {
    return 0
  }
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

function inventory(ctx, disabled, sessionId, state) {
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
    if (row.raw === undefined) row.raw = []
    row.raw.push(schema)
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
    const bridgeSchemas = schemas.filter((schema) => RESOURCE_TOOLS.includes(schema.name))
    const resourceTools = bridgeSchemas.map((schema) => ({
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
      raw: bridgeSchemas,
      provider: RESOURCE_BRIDGE_PACKAGE,
    })
  }

  const provider = adapters.length === 1 ? adapters[0].name : undefined
  const rows = [...servers.values()].map((row) => {
    row.active = row.toolCount > 0
    if (row.source === 'plugin' && provider !== undefined) row.provider = provider
    if (row.source === 'plugin' || row.source === 'bridge') row.toggleable = true
    if (off.has(row.name)) {
      row.enabled = false
      row.disabled = true
    }
    return row
  })
  const rank = (row) => (row.source === 'plugin' ? 0 : row.source === 'bridge' ? 1 : 2)
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // Price each server's tool schemas with the harness' own heuristic so the
  // numbers match the context breakdown the app already shows. Each tool keeps
  // its own price too, for the row-level chips.
  let toolTokens = 0
  for (const row of rows) {
    const schemas = Array.isArray(row.raw) ? row.raw : []
    const priceOf = new Map()
    for (const schema of schemas) priceOf.set(schema.name, estimateSchemaTokens(schema))
    row.tools = (Array.isArray(row.tools) ? row.tools : []).map((tool) => ({
      ...tool,
      tokens: priceOf.get(tool.name) ?? 0,
    }))
    row.tokens = estimateToolTokens(row.raw)
    toolTokens += row.tokens
    delete row.raw
  }

  // Per-conversation view: which rows this session overrides, and what the
  // profile default would be without those overrides.
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const sessions = state !== null && typeof state === 'object' && state.sessions !== null && typeof state.sessions === 'object'
      ? state.sessions
      : {}
    const over = sessions[sessionId]
    const on = new Set(Array.isArray(over?.on) ? over.on : [])
    const offNames = new Set(Array.isArray(over?.off) ? over.off : [])
    const globalOff = new Set(Array.isArray(state?.disabled) ? state.disabled : [])
    for (const row of rows) {
      row.session = sessionId
      row.globalEnabled = row.source === 'plugin' || row.source === 'bridge'
        ? !globalOff.has(row.name)
        : row.enabled === true || offNames.has(row.name)
      row.override = on.has(row.name) ? 'on' : offNames.has(row.name) ? 'off' : null
    }
  }

  const summary = {
    servers: rows.length,
    active: rows.filter((row) => row.active && row.enabled !== false).length,
    tools: rows.reduce((total, row) => total + row.toolCount, 0),
    tokens: toolTokens,
    plugin: rows.filter((row) => row.source === 'plugin').length,
    bridge: rows.filter((row) => row.source === 'bridge').length,
    declared: rows.filter((row) => row.source === 'profile').length,
    disabled: rows.filter((row) => row.enabled === false).length,
    overrides: typeof sessionId === 'string' && sessionId.length > 0
      ? rows.filter((row) => row.override !== null).length
      : 0,
    sessions: state !== null && typeof state === 'object' && state.sessions !== null && typeof state.sessions === 'object'
      ? Object.keys(state.sessions).length
      : 0,
  }

  return {
    ok: true,
    session: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
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
      clientDiag: CLIENT_DIAG.slice(0, 12),
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

/* -------------------------------------------------------------------------- */
/* The two extra page tabs: tool definitions and system-prompt sections        */
/* -------------------------------------------------------------------------- */

/** Names the user switched off, read from the persisted state shape. */
function nameList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const name of value) {
    if (typeof name === 'string' && name.length > 0 && !out.includes(name)) out.push(name)
  }
  return out
}

function toolNamesOff(state) {
  return nameList(state?.tools)
}

function promptNamesOff(state) {
  return nameList(state?.prompts)
}

/** Replace one name's switch state inside a plain name list. */
function withName(list, name, wanted) {
  const set = new Set(nameList(list))
  if (wanted) set.delete(name)
  else set.add(name)
  return [...set].sort()
}

/** The names `tools.restrict()` would accept, or null when unreadable. */
function restrictableOf(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || typeof tools.view !== 'function') return null
    const view = tools.view(undefined)
    const names = view?.restrictableNames
    if (names !== undefined && names !== null && typeof names.has === 'function' && typeof names[Symbol.iterator] === 'function') {
      return names instanceof Set ? names : new Set(names)
    }
  } catch { /* private API moved: report rows as toggleable and let the denied call decide */ }
  return null
}

/** Server names declared in the profile: longest first, for prefix matching. */
function declaredServerNames(ctx) {
  const out = []
  try {
    for (const entry of readEntries(ctx).rows) {
      if (entry.name !== MCP_CLIENT_PACKAGE) continue
      const name = asString(entry.config?.serverName)
      if (name !== undefined && !out.includes(name)) out.push(name)
    }
  } catch { /* no loader */ }
  out.sort((a, b) => b.length - a.length)
  return out
}

/** Heuristic size of one tool definition, matching the harness' token meter. */
function estimateSchemaTokens(schema) {
  try {
    return Math.ceil(JSON.stringify(schema).length / CHARS_PER_TOKEN)
  } catch {
    return 0
  }
}

/** Heuristic size of a character count, matching the harness' token meter. */
function estimateCharsTokens(chars) {
  const value = typeof chars === 'number' && Number.isFinite(chars) ? chars : 0
  return value > 0 ? Math.ceil(value / CHARS_PER_TOKEN) : 0
}

/** Heuristic size of plain text (a skill body, a catalog line…). */
function estimateTextTokens(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return 0
  return Math.ceil(value.length / CHARS_PER_TOKEN)
}

/**
 * Read the front matter of one SKILL.md.
 *
 * The body is the whole file: that is what the model receives when the skill is
 * loaded, so its size is what the skill costs.
 */
function readSkillFile(file) {
  let text = ''
  try {
    if (statSync(file).size > 2_000_000) return undefined
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const folder = file.replace(/[\\/][^\\/]+$/, '')
  const name = folder.split(/[\\/]/).pop() ?? ''
  const declared = /^---\s*$([\s\S]*?)^---\s*$/m.exec(text)
  const meta = declared === null ? '' : declared[1]
  const field = (key) => {
    const hit = new RegExp('^' + key + '\\s*:\\s*(.+)$', 'm').exec(meta)
    if (hit === null) return undefined
    return hit[1].trim().replace(/^['"]|['"]$/g, '')
  }
  return {
    name: field('name') ?? name,
    description: field('description') ?? '',
    path: file,
    chars: text.length,
  }
}

/** SKILL.md files under `dir`, depth-limited, skipping nested node_modules. */
function skillFilesIn(dir, depth, out) {
  if (depth > 4) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' && depth > 0) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) skillFilesIn(full, depth + 1, out)
    else if (entry.name === 'SKILL.md') {
      const skill = readSkillFile(full)
      if (skill !== undefined) out.push(skill)
    }
  }
  return out
}

/**
 * Every skill file the panel's Global list can show: the user's own skills
 * (`<dshHome>/skills`) and the ones plugin packages ship
 * (`<profile>/node_modules/<package>/…/SKILL.md`).
 */
function skillFilesOnDisk() {
  const found = []
  skillFilesIn(join(dshHome(), 'skills'), 1, found)
  let profiles = []
  try {
    profiles = readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })
  } catch {
    profiles = []
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    const modules = join(dshHome(), 'profiles', profile.name, 'node_modules')
    let entries = []
    try {
      entries = readdirSync(modules, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const root = join(modules, entry.name)
      if (entry.name.startsWith('@')) {
        let scoped = []
        try {
          scoped = readdirSync(root, { withFileTypes: true })
        } catch {
          scoped = []
        }
        for (const inner of scoped) {
          if (inner.isDirectory()) skillFilesIn(join(root, inner.name), 1, found)
        }
      } else skillFilesIn(root, 1, found)
    }
  }
  return found
}

/**
 * The skill catalog, priced two ways: how much a skill costs once its body is
 * loaded, and how much its catalog line already costs on every request.
 */
async function skillsPayload(ctx) {
  const skills = serviceOf(ctx, 'skills')
  const merged = new Map()
  // Files first: that is what the panel lists, including the user's own skills
  // and the ones plugin packages ship.
  for (const file of skillFilesOnDisk()) {
    if (merged.has(file.name)) continue
    merged.set(file.name, {
      name: file.name,
      description: asString(file.description, 200) ?? '',
      source: 'filesystem',
      provider: 'files',
      chars: file.chars,
      tokens: estimateCharsTokens(file.chars),
      catalog: 0,
    })
  }
  // Then the registry: it knows the bundled skills and the exact bodies.
  if (skills !== undefined && typeof skills.list === 'function') {
    let summaries = []
    let scope
    try {
      const agents = serviceOf(ctx, 'agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      const agent = Array.isArray(list) ? list[0] : undefined
      scope = agent?.ctx
    } catch { scope = undefined }
    try {
      summaries = await skills.list(scope !== undefined ? { scope } : {})
    } catch {
      summaries = []
    }
    for (const summary of Array.isArray(summaries) ? summaries : []) {
      const name = asString(summary?.name)
      if (name === undefined) continue
      const description = asString(summary?.description, 200) ?? ''
      let chars = merged.get(name)?.chars ?? 0
      try {
        const definition = typeof skills.get === 'function' ? await skills.get(name, {}) : undefined
        if (typeof definition?.content === 'string') chars = definition.content.length
      } catch { /* keep the file size */ }
      merged.set(name, {
        name,
        description,
        source: asString(summary?.source) ?? 'runtime',
        provider: asString(summary?.provider) ?? '',
        chars,
        tokens: estimateCharsTokens(chars),
        catalog: 0,
      })
    }
  }
  const rows = [...merged.values()]
  for (const row of rows) row.catalog = estimateTextTokens(row.name + ' ' + row.description)
  rows.sort((a, b) => a.name.localeCompare(b.name))
  if (rows.length === 0) {
    return { ok: false, kind: 'skills', error: 'no skill file was found', skills: [] }
  }
  return {
    ok: true,
    kind: 'skills',
    generatedAt: new Date().toISOString(),
    summary: {
      skills: rows.length,
      tokens: rows.reduce((total, row) => total + row.tokens, 0),
      catalog: rows.reduce((total, row) => total + row.catalog, 0),
      loaded: rows.filter((row) => row.chars > 0).length,
    },
    skills: rows,
  }
}

/**
 * The exact definition the model receives, pretty-printed for the expanded row.
 *
 * Only the three model-visible fields are kept: that is what the schema really
 * costs and what the model actually reads.
 */
function definitionText(schema) {
  try {
    const visible = {
      name: schema.name,
      description: typeof schema.description === 'string' ? schema.description : '',
      parameters: schema.parameters,
    }
    const text = JSON.stringify(visible, null, 2)
    return {
      definition: text.length > TOOL_TEXT_LIMIT ? text.slice(0, TOOL_TEXT_LIMIT) : text,
      definitionTruncated: text.length > TOOL_TEXT_LIMIT,
    }
  } catch {
    return { definition: '', definitionTruncated: false }
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin attribution by name (heuristic)                                      */
/* -------------------------------------------------------------------------- */

/** Package words that identify no plugin: they appear in half of them. */
const GENERIC_WORDS = new Set([
  'dsh', 'tool', 'tools', 'client', 'ui', 'host', 'plugin', 'plugins', 'local', 'experimental',
  'bundle', 'preset', 'app', 'core', 'api', 'registry', 'provider', 'system', 'prompt', 'session',
  'agent', 'goal', 'plan', 'jobs', 'skill', 'mcp', 'web', 'fs', 'harness', 'index', 'dist', 'src',
  'deepseek', 'openai', 'node', 'http', 'https', 'github', 'main',
])

/** Strip the npm scope so the tag stays readable. */
function shortPluginName(name) {
  const text = asString(name, 120)
  if (text === undefined) return undefined
  const slug = text.split('/').pop()
  return slug.replace(/\.js$/i, '')
}

/** Significant words of a package name, in package order. */
function wordsOfPackage(name) {
  const base = String(name).split('/').pop().replace(/\.js$/i, '').replace(/^dsh-/, '')
  const words = []
  for (const word of base.split(/[-_]/)) {
    const token = word.toLowerCase()
    if (token.length < 4 || GENERIC_WORDS.has(token) || words.includes(token)) continue
    words.push(token)
  }
  return { base: base.toLowerCase(), words }
}

/**
 * Candidate plugins to attribute a name to, built from the live composition.
 *
 * This is a heuristic and says so: it only uses package words, so a tool whose
 * name shares nothing with its plugin stays untagged instead of being guessed.
 */
function ownerTable(ctx) {
  const table = []
  try {
    for (const entry of readEntries(ctx).rows) {
      if (entry.disabled === true) continue
      const name = entry.name
      if (typeof name !== 'string' || name.length === 0) continue
      if (name.startsWith('file:') || name.includes('\\')) continue
      const parsed = wordsOfPackage(name)
      if (parsed.words.length === 0) continue
      table.push({
        name,
        base: parsed.base,
        words: parsed.words,
        primary: parsed.words[0],
        last: parsed.words[parsed.words.length - 1],
      })
    }
  } catch { /* no loader: nothing is tagged */ }
  return table
}

/** Words of a tool or section name, for whole-word comparisons. */
function nameWords(name) {
  return String(name).toLowerCase().split(/[:_-]/).filter((word) => word.length > 0)
}

/**
 * Tools whose owner the name cannot reveal, checked against the installed
 * package rather than guessed: `dsh-free-search` ships `lib/research.js` and
 * `lib/weather.js` and registers exactly these names.
 */
const TOOL_OWNER_HINTS = {
  research: 'dsh-free-search',
  weather: 'dsh-free-search',
}

/**
 * Best-effort plugin for one tool (`tool`) or prompt section (`section`).
 *
 * Strong signals only: the name starts with a package word, or a section's
 * prefix does, or one long package word appears verbatim in the name. Two
 * different plugins matching just as well means no tag at all — except that an
 * installed plugin beats a first-party package, since the first-party web
 * search provider shares the word "search" with a third-party search plugin.
 */
function guessOwner(kind, name, table) {
  const parts = nameWords(name)
  const lower = String(name).toLowerCase()
  const slug = lower.replace(/_/g, '-')
  const prefix = lower.split(':')[0].replace(/-/g, '_')
  const last = parts[parts.length - 1]
  const matches = []
  for (const entry of table) {
    if (entry.base === slug) { matches.push({ plugin: entry.name, token: slug, score: 5 }); continue }
    if (entry.base === 'tool-' + slug) { matches.push({ plugin: entry.name, token: slug, score: 4 }); continue }
    for (const token of entry.words) {
      let score = 0
      // Only the package's own leading word may act as a prefix: otherwise a
      // generic tail ("cache", "domain", "platform") tags unrelated tools.
      if (token === entry.primary) {
        if (kind === 'tool') {
          if (lower.startsWith(token + '_')) score = 3
          else if (parts.includes(token) && token.length >= 6) score = 2
        } else {
          if (prefix === token || prefix.startsWith(token + '_')) score = 3
          else if (parts.includes(token) && token.length >= 6) score = 2
        }
      } else if (token === entry.last && token === last && token.length >= 6) {
        // The name ends with the plugin's own last word ("*_search" -> free-search).
        score = 2
      }
      if (score > 0) matches.push({ plugin: entry.name, token, score })
    }
  }
  if (matches.length === 0) return undefined
  const thirdParty = (plugin) => !String(plugin).startsWith('@deepseek-ai/')
  matches.sort((a, b) => (b.score - a.score)
    || (b.token.length - a.token.length)
    || (thirdParty(a.plugin) === thirdParty(b.plugin) ? 0 : (thirdParty(a.plugin) ? -1 : 1))
    || a.plugin.localeCompare(b.plugin))
  const best = matches[0]
  const rival = matches[1]
  if (rival !== undefined && rival.score === best.score && rival.token === best.token
    && thirdParty(rival.plugin) === thirdParty(best.plugin)) return undefined
  return shortPluginName(best.plugin)
}

/**
 * Attribution for the sections an MCP server publishes.
 *
 * The section name is the server, and the inventory already knows which plugin
 * mounts it, so this one is not a guess at all.
 */
function mcpSectionOwner(serverName, table, serversOf) {
  if (serverName === RESOURCE_BRIDGE_NAME) return shortPluginName(RESOURCE_BRIDGE_PACKAGE)
  try {
    const row = serversOf().find((server) => server.name === serverName)
    if (row !== undefined) {
      if (typeof row.provider === 'string' && row.provider.length > 0) return shortPluginName(row.provider)
      if (row.source === 'profile') return shortPluginName(MCP_CLIENT_PACKAGE)
    }
  } catch { /* fall through to the name heuristic */ }
  return guessOwner('section', 'mcp:' + serverName, table)
}

/** Every public tool the Host currently registers, one row each. */
async function toolsPayload(ctx, state, wantApplied) {
  const { available, rows: schemas } = readSchemas(ctx)
  const declared = declaredServerNames(ctx)
  const restrictable = restrictableOf(ctx)
  const off = new Set(toolNamesOff(state))
  const table = ownerTable(ctx)

  const rows = []
  const seen = new Set()
  for (const schema of schemas) {
    if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') continue
    if (seen.has(schema.name)) continue
    seen.add(schema.name)
    const server = RESOURCE_TOOLS.includes(schema.name)
      ? RESOURCE_BRIDGE_NAME
      : serverOfTool(schema.name, declared)
    // MCP servers already have their own section in the panel, with a card and
    // a per-server switch: this tab only covers the harness' own tools.
    if (server !== undefined) continue
    rows.push({
      ...definitionText(schema),
      name: schema.name,
      group: hintedOwner(ctx, schema.name, table) ?? UNATTRIBUTED,
      description: asString(schema.description, 220) ?? '',
      tokens: estimateSchemaTokens(schema),
      enabled: !off.has(schema.name),
      owner: hintedOwner(ctx, schema.name, table),
      serverDisabled: false,
      locked: restrictable !== null && !restrictable.has(schema.name),
    })
  }
  // Plugin groups first, alphabetical; the tools no plugin claims go last.
  rows.sort(compareGroups)

  const groups = groupsOf(rows)

  const result = {
    ok: true,
    kind: 'tools',
    generatedAt: new Date().toISOString(),
    summary: {
      tools: rows.length,
      on: rows.filter((row) => row.enabled).length,
      off: rows.filter((row) => !row.enabled).length,
      tokens: rows.reduce((total, row) => total + (row.enabled ? row.tokens : 0), 0),
      restricted: rows.filter((row) => row.locked).length,
    },
    groups,
    tools: rows,
    diagnostics: {
      schemasAvailable: available,
      restrictable: restrictable === null ? null : restrictable.size,
      switchedOff: [...off].length,
      owned: rows.filter((row) => row.owner !== undefined).length,
    },
  }
  if (wantApplied === true) result.applied = appliedTools(ctx, [...off])
  return result
}

/**
 * Proof of effect for the route: the schema set each live Agent would receive
 * right now. A switched-off tool listed under `visible` was not denied (it is
 * not restrictable), which the row already reports as `locked`.
 */
function appliedTools(ctx, off) {
  if (off.length === 0) return { agents: 0, hidden: [], visible: [] }
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || typeof tools.schemas !== 'function') return { agents: 0, error: 'no tools service' }
  let agents = []
  try {
    const list = serviceOf(ctx, 'agents')?.list?.()
    if (Array.isArray(list)) agents = list
  } catch { agents = [] }
  const hidden = new Map()
  const visible = new Map()
  const errors = []
  let count = 0
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object') continue
    count += 1
    let names
    try {
      names = new Set()
      for (const schema of tools.schemas(agent) ?? []) {
        if (schema !== null && typeof schema === 'object' && typeof schema.name === 'string') names.add(schema.name)
      }
    } catch (error) {
      errors.push(String(error?.message ?? error).slice(0, 180))
      continue
    }
    for (const name of off) {
      const map = names.has(name) ? visible : hidden
      map.set(name, (map.get(name) ?? 0) + 1)
    }
  }
  return {
    agents: count,
    hidden: [...hidden.keys()].sort(),
    visible: [...visible.keys()].sort(),
    errors: errors.slice(0, 4),
  }
}

/** Tool owner: an explicit, verified hint first, then the name heuristic. */
function hintedOwner(ctx, toolName, table) {
  const hint = TOOL_OWNER_HINTS[toolName]
  if (hint !== undefined) {
    // Only trust the hint while that plugin is actually loaded.
    const known = table.some((entry) => String(entry.name).split('/').pop() === hint)
    if (known) return hint
  }
  return guessOwner('tool', toolName, table)
}

/** The prompt registry, read without running an assembly. */
function promptRegistry(ctx) {
  const prompt = serviceOf(ctx, 'systemPrompt')
  const out = { available: prompt !== undefined, map: new Map(), error: null }
  if (prompt === undefined) return out
  try {
    const layers = prompt.layers
    if (layers !== undefined && layers !== null && typeof layers.merge === 'function') {
      for (const [name, section] of layers.merge(undefined, (layer) => layer.sections)) {
        if (typeof name === 'string' && section !== null && typeof section === 'object') out.map.set(name, section)
      }
    }
  } catch (error) {
    out.error = String(error?.message ?? error).slice(0, 240)
  }
  return out
}

/**
 * One-line description of a prompt section, for the page tab.
 *
 * Known sections get a hand-written sentence; anything a plugin contributes
 * later falls back to the first line of its own text so the row is never bare.
 */
function describeSection(name, text) {
  const fixed = {
    'harness:identity': 'Fixed opener: the identity the harness gives the model.',
    'deployment:persona-prefix': 'Persona text rendered before the harness guidance.',
    'deployment:persona-suffix': 'Persona text rendered after the harness guidance.',
    'plan:policy': 'Plan-mode policy; empty unless plan mode is active.',
    'team:policy': 'Rules the agent team is expected to follow.',
    'tools:ptc-only': 'How the code-execution transport is used.',
    'tools:sdk': 'Generated SDK documentation for the tools of this step.',
    'context:file-reference': 'How @file references are resolved.',
    'mcp-resource-servers': 'Instructions for the MCP resource tools.',
    'ui:deliverable-file-references': 'How deliverable file references are presented.',
    'harness:source': 'Where this harness build keeps its source.',
    'app:web-surface': 'Which web surface this session runs in.',
    'free-search:engines': 'The configured search engines and how to query them.',
  }
  if (Object.hasOwn(fixed, name)) return fixed[name]
  if (name.startsWith('mcp:')) return 'Instructions published by the MCP server ' + name.slice(4) + '.'
  if (name.startsWith('tool:')) return 'Guidance for using the ' + name.slice(5) + ' tool.'
  if (name.startsWith('context:')) return 'Runtime context ' + name.slice(8) + '.'
  const body = typeof text === 'string' ? text : ''
  const first = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  if (first !== undefined) return first.length > 150 ? first.slice(0, 147) + '\u2026' : first
  return 'Prompt section contributed by a plugin.'
}

/**
 * Every system-prompt section, in the order the model receives it.
 *
 * `assemble()` is preferred because it resolves text callbacks exactly the way
 * the loop does; when it is unavailable the registry's raw entries are shown so
 * the tab still lists every section. Agent-scoped shadows (an agent preset
 * persona) are not listed: this view is the profile-wide prompt.
 */
async function promptsPayload(ctx, state, wantApplied) {
  const prompt = serviceOf(ctx, 'systemPrompt')
  const registry = promptRegistry(ctx)
  let assembled = null
  let assembleError = null
  if (prompt !== undefined && typeof prompt.assemble === 'function') {
    try {
      assembled = await prompt.assemble({})
    } catch (error) {
      assembleError = String(error?.message ?? error).slice(0, 240)
    }
  }

  const off = new Set(promptNamesOff(state))
  const table = ownerTable(ctx)
  // One inventory pass, and only when an MCP section actually asks for it.
  let servers = null
  const serversOf = () => {
    if (servers === null) {
      try { servers = inventory(ctx, new Set(), null, null).servers ?? [] } catch { servers = [] }
    }
    return servers
  }
  const rows = []
  const seen = new Set()
  const add = (name, text, order, dynamic) => {
    if (seen.has(name)) return
    seen.add(name)
    const body = typeof text === 'string' ? text : ''
    const owner = name === RESOURCE_BRIDGE_NAME
      ? shortPluginName(RESOURCE_BRIDGE_PACKAGE)
      : name.startsWith('mcp:')
        ? mcpSectionOwner(name.slice(4), table, serversOf)
        : name.startsWith('tool:')
          // `tool:<name>` is the guidance of that tool: same owner as the tool.
          ? guessOwner('tool', name.slice(5), table)
          : guessOwner('section', name, table)
    rows.push({
      name,
      order: Number.isFinite(order) ? order : 0,
      tokens: Math.ceil(body.length / CHARS_PER_TOKEN),
      chars: body.length,
      empty: body.length === 0,
      dynamic: dynamic === true,
      enabled: !off.has(name),
      description: describeSection(name, body),
      owner,
      group: owner ?? UNATTRIBUTED,
      sortKey: Number.isFinite(order) ? order : 0,
      truncated: body.length > PROMPT_TEXT_LIMIT,
      text: body.length > PROMPT_TEXT_LIMIT ? body.slice(0, PROMPT_TEXT_LIMIT) : body,
    })
  }

  if (assembled !== null && Array.isArray(assembled.sections)) {
    for (const section of assembled.sections) {
      if (section === null || typeof section !== 'object' || typeof section.name !== 'string') continue
      const known = registry.map.get(section.name)
      add(section.name, section.text, asNumber(known?.order), false)
    }
  } else {
    for (const [name, section] of registry.map) {
      let text = ''
      let dynamic = false
      if (typeof section.text === 'string') text = section.text
      else if (typeof section.text === 'function') {
        dynamic = true
        try {
          const value = section.text({})
          if (typeof value === 'string') text = value
        } catch { /* context-dependent text: listed without a body */ }
      }
      add(name, text, asNumber(section.order), dynamic)
    }
  }
  rows.sort(compareGroups)

  const result = {
    ok: true,
    kind: 'prompts',
    generatedAt: new Date().toISOString(),
    summary: {
      sections: rows.length,
      on: rows.filter((row) => row.enabled).length,
      off: rows.filter((row) => !row.enabled).length,
      tokens: rows.reduce((total, row) => total + (row.enabled ? row.tokens : 0), 0),
    },
    groups: groupsOf(rows),
    prompts: rows,
    diagnostics: {
      service: prompt !== undefined,
      assembled: assembled !== null,
      assembleError,
      registryError: registry.error,
      registry: registry.map.size,
      owned: rows.filter((row) => row.owner !== undefined).length,
    },
  }
  if (wantApplied === true) result.applied = await appliedSections(ctx, prompt, promptNamesOff(state))
  return result
}

/**
 * Proof of effect, for the route only: assemble each live Agent's prompt and
 * report which switched-off sections no longer contribute any text. A section
 * that stays visible is one whose owner registered it in the same scope (an
 * agent preset), which cannot be shadowed.
 */
async function appliedSections(ctx, prompt, off) {
  if (off.length === 0) return { agents: 0, hidden: [], visible: [] }
  if (prompt === undefined || typeof prompt.assemble !== 'function') return { agents: 0, error: 'no systemPrompt service' }
  let agents = []
  try {
    const list = serviceOf(ctx, 'agents')?.list?.()
    if (Array.isArray(list)) agents = list
  } catch { agents = [] }
  const hidden = new Map()
  const visible = new Map()
  const errors = []
  let count = 0
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object') continue
    count += 1
    try {
      const assembly = await prompt.assemble({ agent, scope: agent })
      const contributing = new Set()
      for (const section of Array.isArray(assembly?.sections) ? assembly.sections : []) {
        if (section !== null && typeof section === 'object' && typeof section.text === 'string' && section.text.length > 0) {
          contributing.add(section.name)
        }
      }
      for (const name of off) {
        const map = contributing.has(name) ? visible : hidden
        map.set(name, (map.get(name) ?? 0) + 1)
      }
    } catch (error) {
      errors.push(String(error?.message ?? error).slice(0, 180))
    }
  }
  return {
    agents: count,
    // Present in no agent's prompt: the shadow is in effect.
    hidden: [...hidden.keys()].sort(),
    // Still contributing text somewhere: the owner owns the scope too.
    visible: [...visible.keys()].sort(),
    errors: errors.slice(0, 4),
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

/** Deny set for one conversation: profile default plus its own overrides. */
function offSetFor(state, sessionId) {
  const off = new Set(Array.isArray(state?.disabled) ? state.disabled : [])
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const over = state?.sessions?.[sessionId]
    if (over !== undefined && over !== null) {
      for (const name of Array.isArray(over.off) ? over.off : []) off.add(name)
      for (const name of Array.isArray(over.on) ? over.on : []) off.delete(name)
    }
  }
  return off
}

/**
 * Write one switch: a conversation override when `sessionId` is given, the
 * profile default otherwise. An override equal to the default is dropped, so
 * the file only ever records real differences.
 */
function writeToggle(state, name, wanted, sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const sessions = state.sessions !== null && typeof state.sessions === 'object' ? state.sessions : {}
    const current = sessions[sessionId]
    const row = {
      on: Array.isArray(current?.on) ? current.on.filter((value) => value !== name) : [],
      off: Array.isArray(current?.off) ? current.off.filter((value) => value !== name) : [],
      at: 0,
    }
    const globalOn = !state.disabled.includes(name)
    if (wanted !== globalOn) {
      if (wanted) row.on.push(name)
      else row.off.push(name)
    }
    row.at = Date.now()
    if (row.on.length === 0 && row.off.length === 0) delete sessions[sessionId]
    else sessions[sessionId] = row
    state.sessions = sessions
    return
  }
  const next = state.disabled.filter((value) => value !== name)
  if (!wanted) next.push(name)
  state.disabled = next
}

export function apply(ctx) {
  const state = loadState()

  let controller
  try {
    controller = attachDisableController(
      ctx,
      // Denied for one conversation: the MCP servers switched off there, plus
      // the individual tools switched off for the whole profile.
      (agentId) => [...denyNames(ctx, offSetFor(state, agentId)), ...toolNamesOff(state)],
      // Hidden for every conversation: the prompt sections switched off.
      () => promptNamesOff(state),
    )
    ctx.on('agent/created', (payload) => pushDiag('agent-created', String(payload?.agent?.id ?? '')))
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
          const paramOf = (name, max) => {
            const raw = url.searchParams.get(name)
            return typeof raw === 'string' && raw.length > 0 ? raw.slice(0, max) : null
          }
          const diag = paramOf('diag', 60)
          if (diag !== null) pushDiag(diag, paramOf('text', 300) ?? '')
          const view = paramOf('view', 20)

          // One tool of the tab list: the switch is profile-wide, so the same
          // per-Agent deny the MCP switches use carries it.
          const toggleTool = paramOf('toggleTool', 200)
          if (toggleTool !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const known = (await toolsPayload(ctx, state)).tools.find((row) => row.name === toggleTool)
            if (known === undefined) {
              sendJson(res, 400, { ok: false, kind: 'tools', error: 'unknown tool: ' + toggleTool })
              return
            }
            state.tools = withName(state.tools, toggleTool, wanted)
            try {
              await saveState(state)
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the tool switches: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            controller?.syncAll()
            sendJson(res, 200, await toolsPayload(ctx, state, url.searchParams.get('applied') === '1'))
            return
          }

          // One system-prompt section: hidden by an empty Agent-scoped shadow.
          const togglePrompt = paramOf('togglePrompt', 200)
          if (togglePrompt !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const before = await promptsPayload(ctx, state)
            const known = before.prompts.some((row) => row.name === togglePrompt)
              || promptNamesOff(state).includes(togglePrompt)
            if (!known) {
              sendJson(res, 400, { ok: false, kind: 'prompts', error: 'unknown prompt section: ' + togglePrompt })
              return
            }
            state.prompts = withName(state.prompts, togglePrompt, wanted)
            try {
              await saveState(state)
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the prompt switches: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            controller?.syncAll()
            sendJson(res, 200, await promptsPayload(ctx, state, url.searchParams.get('applied') === '1'))
            return
          }

          // A whole group switched at once: the tab header carries one switch
          // per group of more than one row, so this is the batch form of the
          // two single switches above — one persist, one reapply.
          const toggleTools = paramOf('toggleTools', 4000)
          if (toggleTools !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const names = toggleTools.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
            const known = new Set((await toolsPayload(ctx, state)).tools.map((row) => row.name))
            const usable = names.filter((name) => known.has(name))
            if (usable.length === 0) {
              sendJson(res, 400, { ok: false, kind: 'tools', error: 'no known tool in that list' })
              return
            }
            for (const name of usable) state.tools = withName(state.tools, name, wanted)
            try {
              await saveState(state)
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the tool switches: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            controller?.syncAll()
            sendJson(res, 200, await toolsPayload(ctx, state, url.searchParams.get('applied') === '1'))
            return
          }

          const togglePrompts = paramOf('togglePrompts', 4000)
          if (togglePrompts !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const names = togglePrompts.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
            const before = await promptsPayload(ctx, state)
            const listed = new Set(before.prompts.map((row) => row.name))
            const usable = names.filter((name) => listed.has(name) || promptNamesOff(state).includes(name))
            if (usable.length === 0) {
              sendJson(res, 400, { ok: false, kind: 'prompts', error: 'no known prompt section in that list' })
              return
            }
            for (const name of usable) state.prompts = withName(state.prompts, name, wanted)
            try {
              await saveState(state)
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the prompt switches: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            controller?.syncAll()
            sendJson(res, 200, await promptsPayload(ctx, state, url.searchParams.get('applied') === '1'))
            return
          }

          if (view === 'skills') {
            sendJson(res, 200, await skillsPayload(ctx))
            return
          }

          if (view === 'tools' || view === 'prompts') {
            if (method === 'HEAD') {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end()
              return
            }
            sendJson(res, 200, view === 'tools' ? await toolsPayload(ctx, state, url.searchParams.get('applied') === '1') : await promptsPayload(ctx, state, url.searchParams.get('applied') === '1'))
            return
          }

          const sessionId = paramOf('session', 200)
          const toggle = method === 'GET' ? url.searchParams.get('toggle') : null
          if (toggle !== null) {
            const wanted = url.searchParams.get('enabled') === 'true'
            const before = inventory(ctx, offSetFor(state, sessionId), sessionId, state)
            const target = before.servers.find((row) => row.name === toggle && (row.toggleable === true || row.active === true))
            if (target === undefined) {
              sendJson(res, 400, { ok: false, error: 'unknown toggle target: ' + toggle })
              return
            }
            writeToggle(state, toggle, wanted, sessionId)
            try {
              await saveState(state)
            } catch (error) {
              try { ctx.logger?.warn?.('dsh-customizer: cannot persist the disabled list: %s', String(error?.message ?? error)) } catch { /* no logger */ }
            }
            if (sessionId !== null) controller?.syncOne(sessionId)
            else controller?.setChanged()
          }
          const payload = inventory(ctx, offSetFor(state, sessionId), sessionId, state)
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
