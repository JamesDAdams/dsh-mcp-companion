/**
 * Host half support for the MCP toggles.
 *
 * A server another plugin mounts (wincu) and the Host's MCP resource bridge
 * have no `cordis.patch.yml` row, so the Skill/MCP panel cannot enable or
 * disable them the way it does for declared rows. This module gives those two
 * cards a real, reversible switch: while a card is off, its tools are denied in
 * every Agent scope, so they disappear from the model schema and cannot be
 * called.
 *
 * The mechanism is the one the panel itself uses (and documents in
 * dsh-skill-mcp-panel/lib/tool-filter.js): `ctx.tools.restrict({ deny })` is
 * only accepted on a scoped context, so one small plugin per Agent registers
 * the restriction on `agent.ctx`, and a reentrancy guard keeps the synchronous
 * `tools/change` emission from looping.
 *
 * State lives in `<dshHome>/dsh-customizer/state.json`:
 *   { "version": 1, "disabled": ["wincu", "mcp-resource-servers"] }
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import os from 'node:os'

export const STATE_VERSION = 1

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(os.homedir(), '.dsh')
}

export function statePath() {
  return join(dshHome(), 'dsh-customizer', 'state.json')
}

/** Read the disabled server names; a missing or broken file means "all on". */
export function loadDisabled() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.disabled)) {
      return parsed.disabled.filter((name) => typeof name === 'string' && name.length > 0)
    }
  } catch {
    // Missing or unreadable state: nothing is disabled.
  }
  return []
}

/** Atomic write of the disabled server names. */
export async function saveDisabled(names) {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify({ version: STATE_VERSION, disabled: names }, null, 2) + '\n'
  const temp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(temp, body, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    if (!['EPERM', 'EEXIST', 'EACCES'].includes(error?.code ?? '')) throw error
    await writeFile(path, body, 'utf8')
  }
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
 * `namesOf()` is evaluated on each (re)application so tools that connect after
 * the switch was flipped are caught by the next `tools/change`.
 */
export class DisableController {
  constructor(ctx, namesOf) {
    this.ctx = ctx
    this.namesOf = namesOf
    this.mounted = new Map()
    this.mounting = new Set()
    this.syncing = false
    this.disposed = false
  }

  /** One tiny plugin per Agent: it owns the restriction on that scope. */
  pluginFor() {
    const holder = { sync: () => {} }
    const namesOf = () => this.namesOf()
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
          const sync = () => {
            if (!live || inside) return
            inside = true
            try {
              run()
            } finally {
              inside = false
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
            const deny = holder.namesOf()
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
          holder.namesOf = namesOf
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

  applyTo(agent) {
    if (this.disposed) return
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined || this.mounted.has(id) || this.mounting.has(id)) return
    const scopeCtx = agent.ctx
    if (scopeCtx === undefined || typeof scopeCtx.plugin !== 'function') return
    this.mounting.add(id)
    try {
      const { plugin, holder } = this.pluginFor()
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

  /** Re-evaluate after the disabled set changed: remount with the new names. */
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
export function attachDisableController(ctx, namesOf) {
  const controller = new DisableController(ctx, namesOf)
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
