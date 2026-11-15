# MCP companion — `dsh-mcp-companion`

Completes DeepSeek Harness's **Skill / MCP** panel: it lists the MCP servers another plugin mounts itself — `wincu` (Windows computer use) and DSH's MCP resource bridge — and turns their cards' switches into **real, persistent toggles**, without modifying that panel's code.

It also adds an **`MCP` button in the new-conversation row**, right of the mode selector (`Standard mode`): its menu turns each MCP server on or off **for that conversation only**, leaving the other agents untouched.

[Version française → `README.md`](README.md)

## The problem

`dsh-skill-mcp-panel` builds its MCP list only from the `@deepseek-ai/dsh-mcp-client` rows in the profile's `cordis.patch.yml`.

Two real MCP servers have no such row:

- **`wincu`**: `dsh-computer-use-win` mounts the MCP client itself with `ctx.plugin(bridge, bridgeConfig(...))`;
- **`mcp-resource-servers`**: the `@deepseek-ai/dsh-mcp-resources` bridge registers three shared tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) that carry no `mcp__<server>__` prefix.

As a result they never appear in the list, and even if they did, their switch would be locked because there is no row to enable or disable.

## What the plugin does

- Adds a **`wincu`** card with its real tools (26 in a full computer-use setup).
- Adds an **`mcp-resource-servers`** card with the MCP resource bridge's three tools.
- Makes the switches **work**:
  - off → the server's tools are removed from the model's schema for every agent;
  - on → they come back;
  - the state is persisted in `%USERPROFILE%\.dsh\dsh-customizer\state.json` (or `$DSH_HOME/dsh-customizer/state.json`) and survives restarts.
- `Test connection` and `Tools` work on those cards (the listed tools are the real ones).
- Everything else stays read-only with a readable message: YAML editing and deletion are refused because those servers belong to another plugin.
- Adds an **`MCP` button** in the new-conversation row (right of `Standard mode`): its menu lists the MCP servers and turns off the ones you do not want **in that conversation**. The choice is stored per conversation.

No other plugin's files are modified, no row is added to the profile's `cordis.patch.yml`, and no second MCP server is started.

## Installation

From GitHub:

```sh
dsh plugin --profile desktop add github:JamesDAdams/dsh-mcp-companion
```

Or, inside the app, through the plugin manager (install a bundle from the package directory). Restart DSH if the Client half is not hot-reloaded.

## Usage

1. Sidebar → **Skill / MCP** → **MCP** tab.
2. `wincu` and `mcp-resource-servers` appear next to the servers declared in the profile.
3. Flip a switch: the effect is immediate and the state is kept across navigation and restarts.

## Per-conversation MCP

On the **New Session** screen, the row that holds the workspace picker and `Standard mode` gains one more **`MCP`** button, snug against the mode control (the button is registered in the additive `conversation.hero.options` slot, then offset to sit right of the mode selector).

- The menu lists the active MCP servers (name, tool count, origin) with one switch each.
- A switch turns that server's tools off **for this conversation's agent only**: every other conversation and agent keeps its tools.
- A server disabled profile-wide can be **re-enabled for a single conversation**: the local override wins over the global setting.
- Conversation settings are persisted and follow the session when you reopen it; a value equal to the global default is not stored, so the file only records real differences.

The button lives in the additive `conversation.hero.options` slot: no extra tab, no DSH UI element replaced.

## How it works

**Host half** (`index.js`, `filter.js`)

- `GET /local-dsh-customizer/mcp-servers` builds the inventory: loader entries (`ctx.loader.entries()`) + actually registered tools (`mcp__<server>__*`) + the resource bridge's tools.
- `GET /local-dsh-customizer/mcp-servers?toggle=<name>&enabled=true|false` flips a server, persists the state and reapplies restrictions.
- `...?session=<id>` returns that conversation's view (with `override` and `globalEnabled` per server); `...&session=<id>&toggle=...` writes a conversation override instead of the profile default.
- Disabling mounts a tiny plugin on each `agent.ctx` that calls `ctx.tools.restrict({ deny })` — the same mechanism `dsh-skill-mcp-panel` uses, with a `tools/change` re-entrancy guard for the loop this API is known for. The deny list is recomputed per agent: profile default + **its own** session overrides.
- State: `<dshHome>/dsh-customizer/state.json` — `disabled` (profile default) and `sessions[<id>] = { on, off, at }` (per-conversation overrides, 120 sessions max).

**Client half** (`client.js`)

- Decorates the panel's Remote service at the `invoke` level: `list` and `reload` results receive the missing servers.
- Discovers the panel namespace **by shape** (`list`/`test`/`setEnabled`/`removeServer` methods), not by name, so a namespace rename does not break it.
- Intercepts `setEnabled` (both positional and object call shapes), calls the Host route and returns the updated view.
- Refuses `save` / `removeServer` / `writeRaw` on those servers with a readable message.
- Registers the `MCP` button in `conversation.hero.options` and renders its menu in an element appended to `body`, so no ancestor can clip it.

## Compatibility

- Tested with DeepSeek Harness Desktop `0.2.2-rc.1` and `dsh-skill-mcp-panel` `2.3.12`.
- Both the panel namespace names (`skillMcpPanel`, `mcpManager`) and both `setEnabled` call shapes (`setEnabled(serverName, enabled, entryId)` and `setEnabled({ serverName, enabled, entryId })`) are supported.
- The `MCP` button uses the `conversation.hero.options` slot ("compact options in the New Session row, after the workspace and preset controls"). If a future version removes that slot, only the button disappears: the panel keeps working.
- If the panel changes its API again, shape-based discovery limits the breakage: please open an issue with the panel version.

## Limitations

- Disabling does **not** stop the server process: `wincu` must keep running for computer use; only its tools are hidden.
- The `MCP` button appears in the **new** conversation row (`New Session`), which is where you pick the servers for the conversation you are about to start. The setting stays attached to that session once it exists.
- Servers declared in `cordis.patch.yml` stay managed by the panel itself.
- This version targets stdio servers mounted by a plugin; remote HTTP servers are out of scope.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-mcp-companion
```

Optionally delete `%USERPROFILE%\.dsh\dsh-customizer\state.json`.

## License

MIT — see [`LICENSE`](LICENSE).
