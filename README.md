# chili3d-mcp

An MCP server that lets an AI drive **Chili3D** — the browser CAD app — in a real browser. The page
owns the document and every modeling tool; this package is the local half that connects an MCP
client to it.

```
Claude Code / Codex / WorkBuddy / Cursor
        │ MCP (stdio)
        ▼
   chili3d-mcp  ── WebSocket ──►  https://chili3d.com/?bridge=17373
        │                           the page's own tool registry
        └── CLI (fallback for agents that only have a shell)
```

The tools are not reimplemented here. `chili3d-mcp` forwards calls to the same registry the app's
in-app assistant runs, so `run_program`, `load_skill`, selections, viewport clicks and screenshots
behave identically whether the work was started from the app or from an external agent.

## Requirements

- Node.js 20+.
- A Chili3D build that includes the `?bridge=` connector. `https://chili3d.com` ships it once
  deployed; for a local build use `--app-url http://localhost:8080`.

## Install

The server is `npx -y @chili3d/mcp mcp`. `init` writes the entry note each agent needs.

### Claude Code

```bash
claude mcp add chili3d -- npx -y @chili3d/mcp mcp
npx -y @chili3d/mcp init --agent claude --user     # ~/.claude/skills/chili3d/SKILL.md
```

### Codex

```bash
npx -y @chili3d/mcp init --agent codex              # AGENTS.md block
```

Then add to `~/.codex/config.toml`:

```toml
[mcp_servers.chili3d]
command = "npx"
args = ["-y", "@chili3d/mcp", "mcp"]
```

### WorkBuddy

```bash
npx -y @chili3d/mcp init --agent workbuddy --user --write
```

Or add this to `~/.workbuddy/mcp.json` yourself:

```json
{
    "mcpServers": {
        "chili3d": { "command": "npx", "args": ["-y", "@chili3d/mcp", "mcp"] }
    }
}
```

Then trust the server: sidebar → Plugins → MCP Servers.

### Cursor

```bash
npx -y @chili3d/mcp init --agent cursor             # .cursor/rules/chili3d.mdc
```

Add the same `mcpServers` entry to `.cursor/mcp.json`.

### Any agent with a shell

The CLI exposes the same tools:

```bash
npx -y @chili3d/mcp start --app-url http://localhost:8080
npx -y @chili3d/mcp status
npx -y @chili3d/mcp list
npx -y @chili3d/mcp call get_document_state
npx -y @chili3d/mcp shot shot.jpg
```

## Using it

1. Call `chili3d_open` (or run `chili3d-mcp open`). It starts the bridge and opens the page; keep
   that tab in the foreground.
2. `chili3d_status` reports `connected: true` once the page has connected back.
3. The page's tools appear as `chili3d_<tool>` — `chili3d_run_program`, `chili3d_get_document_state`,
   `chili3d_select_nodes`, `chili3d_capture_screenshot`, `chili3d_load_skill`, and the rest.
4. A fresh page has no document: `chili3d_new_document` before modeling.

The catalogue is dynamic: `chili3d_open` and `chili3d_status` are always listed, and the page's tools
appear after it connects (the server sends `notifications/tools/list_changed`). Clients that do not
re-list on that notification need their session restarted once the page is connected.

## How it works

| Process | Role |
| --- | --- |
| `chili3d-mcp mcp` | MCP front door over stdio. Starts the daemon if needed and lists its tools. |
| `chili3d-mcp start` | The daemon: WebSocket for the page + loopback HTTP for the front doors. |
| `chili3d-mcp …` | CLI front door, for agents without MCP and for humans. |
| the page | Owns the document and executes every tool (`?bridge=<port>`). |

The daemon lives in `~/.chili3d-mcp` (`session.json`, `daemon.log`). `chili3d-mcp stop` ends it; it
stays up across agent sessions so a page does not have to reconnect.

## Security

- The daemon binds `127.0.0.1` only and rejects a non-loopback `Host` (DNS rebinding).
- The WebSocket accepts exactly one `Origin`: that of `--app-url` (`https://chili3d.com` by
  default, `http://localhost:8080` for a local build). Another page on the same machine cannot take
  the seat and feed tool descriptions to the model.
- `/rpc` rejects any request carrying an `Origin` — browsers always send it, the MCP server and the
  CLI never do, so a web page cannot drive the bridge.
- There is no token: the page's origin is enforced by the browser, and local processes are already
  inside the user's trust boundary.

## Development

```bash
npm install
npm test          # daemon+CLI smoke, then a real MCP client end-to-end
npm run check     # biome
```

## Limitations

- The page must stay in the foreground; background tabs are throttled and screenshots go stale.
- One page at a time. A second page replaces the first.
- A call that times out does not disconnect the page: the seat stays busy and further calls fail
  until the page answers or reconnects, so a slow build never costs an unsaved document.
  `chili3d-mcp status` shows which tool it is waiting on.
- The external agent and the in-app chat panel have no lock between them — do not drive the same
  document from both at once.
