/**
 * Host half support for the MCP toggles.
 *
 * A server another plugin mounts (wincu) and the Host's MCP resource bridge
 * have no `cordis.patch.yml` row, so the Skill/MCP panel cannot enable or
 * disable them the way it does for declared rows. This module gives those two
 * cards a real, reversible switch: while a card is off, its tools are denied in
 * the Agent scope, so they disappear from the model schema and cannot be called.
 *
 * The same mechanism carries the per-conversation switch added in 1.1:
 *
 *   - `disabled` is the profile-wide default (what the panel writes);
 *   - `sessions[<sessionId>]` holds that conversation's overrides: `off` names
 *     denied only there, `on` names explicitly re-enabled there even though the
 *     profile default denies them.
 *
 * The mechanism is the one the panel itself uses (and documents in
 * dsh-skill-mcp-panel/lib/tool-filter.js): `ctx.tools.restrict({ deny })` is
 * only accepted on a scoped context, so one small plugin per Agent registers
 * the restriction on `agent.ctx`, and a reentrancy guard keeps the synchronous
 * `tools/change` emission from looping.
 *
 * Version 3 adds the two Skill/MCP page tabs, which are profile-wide:
 *
 *   - `tools` holds individual public tool names the user switched off; the
 *     same `tools.restrict({ deny })` call carries them, so one tool can be
 *     denied without disabling its whole server;
 *   - `prompts` holds system-prompt section names the user switched off. A
 *     section is hidden by registering an empty section of the same name in the
 *     Agent scope: scoped sections shadow global ones, and an empty section is
 *     dropped when the prompt is rendered, so the owner's registration is never
 *     touched.
 *
 * State lives in `<dshHome>/dsh-customizer/state.json`:
 *   {
 *     "version": 3,
 *     "disabled": ["wincu"],
 *     "tools": ["mcp__wincu__screenshot"],
 *     "prompts": ["tool:bash"],
 *     "sessions": {
 *       "<sessionId>": { "on": [], "off": ["mcp-resource-servers"], "at": 1735000000000 }
 *     }
 *   }
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import os from 'node:os'

export const STATE_VERSION = 3

/** Keep the file bounded: only the most recently touched sessions survive. */
export const MAX_SESSIONS = 120

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(os.homedir(), '.dsh')
}

export function statePath() {
  return join(dshHome(), 'dsh-customizer', 'state.json')
}

function names(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const name of value) {
    if (typeof name === 'string' && name.length > 0 && !out.includes(name)) out.push(name)
  }
  return out
}

/** Read the whole persisted state; a missing or broken file means "all on". */
export function loadState() {
  const empty = { version: STATE_VERSION, disabled: [], tools: [], prompts: [], sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return empty
    const disabled = names(parsed.disabled)
    const tools = names(parsed.tools)
    const prompts = names(parsed.prompts)
    const sessions = {}
    const raw = parsed.sessions
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const id of Object.keys(raw)) {
        if (typeof id !== 'string' || id.length === 0) continue
        const value = raw[id]
        const row = { on: [], off: [], at: 0 }
        if (Array.isArray(value)) {
          // Version 1 of the session shape stored a bare deny list.
          row.off = names(value)
        } else if (value !== null && typeof value === 'object') {
          row.on = names(value.on)
          row.off = names(value.off)
          if (typeof value.at === 'number' && Number.isFinite(value.at)) row.at = value.at
        }
        if (row.on.length === 0 && row.off.length === 0) continue
        sessions[id] = row
      }
    }
    return { version: STATE_VERSION, disabled, tools, prompts, sessions }
  } catch {
    // Missing or unreadable state: nothing is disabled.
    return empty
  }
}

/** Atomic write of the whole state, with the session map pruned. */
export async function saveState(state) {
  const disabled = names(state?.disabled)
  const tools = names(state?.tools)
  const prompts = names(state?.prompts)
  const kept = Object.entries(state?.sessions ?? {})
    .filter(([, row]) => row !== null && typeof row === 'object' && (names(row.on).length > 0 || names(row.off).length > 0))
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, MAX_SESSIONS)
  const sessions = {}
  for (const [id, row] of kept) {
    sessions[id] = {
      on: names(row.on),
      off: names(row.off),
      at: Number(row.at) || Date.now(),
    }
  }
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify({ version: STATE_VERSION, disabled, tools, prompts, sessions }, null, 2) + '\n'
  const temp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(temp, body, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    if (!['EPERM', 'EEXIST', 'EACCES'].includes(error?.code ?? '')) throw error
    await writeFile(path, body, 'utf8')
  }
}

/** Profile-wide deny list (what the Skill/MCP panel switches write). */
export function loadDisabled() {
  return loadState().disabled
}

/** Rewrite the profile-wide list, keeping the per-conversation overrides. */
export async function saveDisabled(list) {
  const state = loadState()
  state.disabled = names(list)
  await saveState(state)
}

function warnOf(ctx, message) {
  try {
    const logger = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
    if (logger !== null && logger !== undefined && typeof logger.warn === 'function') {
      logger.warn('[dsh-customizer] ' + message)
      return
    }
  } catch {
    // No logger service: fall through to the console.
  }
  try { if (typeof console !== 'undefined') console.warn('[dsh-customizer] ' + message) } catch { /* ignore */ }
}

function errorText(error) {
  return error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/**
 * Applies a dynamic deny list to every Agent scope.
 *
 * `namesOf(agentId)` is evaluated on each (re)application so tools that connect
 * after the switch was flipped are caught by the next `tools/change`, and so a
 * per-conversation override always reads the current state.
 */
export class DisableController {
  constructor(ctx, namesOf, sectionsOf) {
    this.ctx = ctx
    this.namesOf = namesOf
    this.sectionsOf = sectionsOf
    this.mounted = new Map()
    this.mounting = new Set()
    this.syncing = false
    this.disposed = false
  }

  /** One tiny plugin per Agent: it owns the restriction on that scope. */
  pluginFor(agentId) {
    const holder = { sync: () => {} }
    const namesFor = () => this.namesOf(agentId)
    const sectionsFor = () => {
      if (typeof this.sectionsOf !== 'function') return []
      try {
        const list = this.sectionsOf(agentId)
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    }
    return {
      holder,
      plugin: {
        name: 'dsh-customizer:tool-deny',
        inject: ['tools'],
        apply(c) {
          let undo
          let applied = null
          let live = true
          let inside = false
          /** section name -> the effect that hides it in this Agent scope. */
          const hidden = new Map()
          let hiddenSignature = null
          const sync = () => {
            if (!live || inside) return
            inside = true
            try {
              run()
            } catch (error) {
              warnOf(c, 'deny sync failed: ' + errorText(error))
            } finally {
              inside = false
            }
            try {
              runSections()
            } catch (error) {
              warnOf(c, 'prompt section sync failed: ' + errorText(error))
            }
          }
          const run = () => {
            let known
            try {
              known = new Set(c.tools.view(undefined).restrictableNames)
            } catch (error) {
              warnOf(c, 'cannot read restrictable tools: ' + errorText(error))
              return
            }
            const deny = namesFor()
            const usable = deny.filter((name) => known.has(name))
            const signature = usable.slice().sort().join('\u0000')
            if (signature === applied) return
            if (undo !== undefined) {
              try { undo() } catch (error) { warnOf(c, 'undo failed: ' + errorText(error)) }
              undo = undefined
              applied = null
            }
            if (usable.length === 0) {
              applied = ''
              return
            }
            try {
              undo = c.tools.restrict({ deny: usable })
              applied = signature
            } catch (error) {
              warnOf(c, 'restrict failed: ' + errorText(error))
              undo = undefined
              applied = null
            }
          }
          /**
           * Hide switched-off prompt sections for this Agent only.
           *
           * A scoped section shadows the global one with the same name, and an
           * empty section is dropped when the prompt renders, so registering an
           * empty shadow is a reversible "off" that never touches the plugin
           * that owns the text. Sections already registered in this very scope
           * (an agent preset persona, for instance) cannot be shadowed: the
           * duplicate is reported once and left alone.
           */
          const runSections = () => {
            let prompt
            try {
              prompt = typeof c.get === 'function' ? c.get('systemPrompt') : undefined
            } catch {
              prompt = undefined
            }
            if (prompt === undefined || prompt === null) return
            if (typeof prompt.section !== 'function') return
            const wanted = [...new Set(sectionsFor().filter((name) => typeof name === 'string' && name.length > 0))].sort()
            const signature = wanted.join('\u0000')
            if (signature === hiddenSignature) return
            for (const [name, disposer] of [...hidden]) {
              if (wanted.includes(name)) continue
              hidden.delete(name)
              try { disposer() } catch (error) { warnOf(c, 'cannot restore prompt section ' + name + ': ' + errorText(error)) }
            }
            for (const name of wanted) {
              if (hidden.has(name)) continue
              try {
                hidden.set(name, prompt.section({ name, order: 0, text: '', interpolate: false }))
              } catch (error) {
                // Keep it in the map with a no-op so the failure is reported
                // once per change instead of on every tools/change pass.
                hidden.set(name, () => {})
                warnOf(c, 'cannot hide prompt section "' + name + '": ' + errorText(error))
              }
            }
            hiddenSignature = signature
          }
          holder.sync = sync
          try {
            c.effect(() => () => {
              live = false
              holder.sync = () => {}
            })
          } catch {
            // Minimal host without effect: at least stop being called by the controller.
          }
          sync()
        },
      },
    }
  }

  syncAll() {
    if (this.disposed || this.syncing) return
    this.syncing = true
    try {
      for (const entry of [...this.mounted.values()]) {
        try { entry.holder.sync() } catch (error) { warnOf(this.ctx, 'reapply failed: ' + errorText(error)) }
      }
    } finally {
      this.syncing = false
    }
  }

  /** Re-evaluate one Agent only: a per-conversation switch must not disturb the others. */
  syncOne(agentId) {
    if (this.disposed) return
    const entry = this.mounted.get(agentId)
    if (entry === undefined) return
    try { entry.holder.sync() } catch (error) { warnOf(this.ctx, 'reapply failed: ' + errorText(error)) }
  }

  applyTo(agent) {
    if (this.disposed) return
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined || this.mounted.has(id) || this.mounting.has(id)) return
    const scopeCtx = agent.ctx
    if (scopeCtx === undefined || typeof scopeCtx.plugin !== 'function') return
    this.mounting.add(id)
    try {
      const { plugin, holder } = this.pluginFor(id)
      const fiber = scopeCtx.plugin(plugin)
      this.mounted.set(id, { fiber, holder })
    } catch (error) {
      warnOf(this.ctx, 'cannot mount the deny plugin (agent ' + id + '): ' + errorText(error))
    } finally {
      this.mounting.delete(id)
    }
  }

  reapply() {
    if (this.disposed) return
    for (const agent of this.listAgents()) this.applyTo(agent)
  }

  release(id) {
    this.mounted.delete(id)
  }

  /** Re-evaluate after the profile-wide set changed: remount with the new names. */
  setChanged() {
    if (this.disposed) return
    this.unmountAll()
    this.reapply()
  }

  unmountAll() {
    for (const [id, entry] of [...this.mounted.entries()]) {
      this.mounted.delete(id)
      try { entry.fiber?.dispose?.() } catch (error) { warnOf(this.ctx, 'unmount failed (agent ' + id + '): ' + errorText(error)) }
    }
  }

  listAgents() {
    try {
      const agents = this.ctx.get('agents')
      const rows = agents?.list?.()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  dispose() {
    this.disposed = true
    this.unmountAll()
  }
}

/** Subscribe the controller to Agent lifecycle and tool changes. */
export function attachDisableController(ctx, namesOf, sectionsOf) {
  const controller = new DisableController(ctx, namesOf, sectionsOf)
  const offCreated = ctx.on('agent/created', (payload) => controller.applyTo(payload?.agent))
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (typeof id === 'string') controller.release(id)
  })
  const offTools = ctx.on('tools/change', () => controller.syncAll())
  controller.reapply()
  const originalDispose = controller.dispose.bind(controller)
  controller.dispose = () => {
    for (const off of [offCreated, offDisposed, offTools]) {
      if (typeof off !== 'function') continue
      try { off() } catch { /* scope already gone */ }
    }
    originalDispose()
  }
  return controller
}
