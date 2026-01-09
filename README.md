# dev-browser-mcp

An MCP (Model Context Protocol) server that lets OpenCode (and other MCP clients) drive a real Chrome/Chromium tab **locally** by sending **Chrome DevTools Protocol (CDP)** commands—without requiring Chrome to be launched with `--remote-debugging-port`.

It solves: *“I want an agent to click/type/navigate/screenshot an existing local browser session”* using a lightweight extension bridge + local relay.

---

## Architecture overview

This project runs an MCP server over **stdio**. Under the hood it talks to a local **relay** that connects to a Chrome/Chromium **extension**.

### Extension-mode relay + endpoints

The relay exposes:

- `ws://HOST:PORT/extension`  
  The **browser extension connects here** (one connection at a time).

- `ws://HOST:PORT/cdp`  
  A **CDP-like WebSocket** endpoint. The MCP server connects here and sends CDP JSON messages.

Tools like `dev_browser_goto`, `dev_browser_click`, etc. ultimately **send CDP commands** (e.g. `Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`) over `/cdp`. The relay forwards those commands to the extension, and forwards CDP events back to connected clients.

---

## Prerequisites

- Node.js **>= 18**
- Chrome/Chromium with the **dev-browser extension** installed (the extension must be running and able to connect to `ws://HOST:PORT/extension`)
- **OpenCode** installed and configured to run MCP servers

---

## Setup

```bash
npm install
npm run build
```

This produces `dist/` and a runnable entrypoint.

---

## OpenCode configuration

OpenCode supports both a **global** config and a **project** config. In both cases, add an MCP server entry named **`dev_browser`**.

### Global config: `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dev_browser": {
      "type": "local",
      "command": ["node", "/Users/<you>/Code/devtools/dev-browser-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "HOST": "127.0.0.1",
        "PORT": "9222",
        "RELAY_MODE": "auto"
      }
    }
  }
}
```

### Project config: `./opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dev_browser": {
      "type": "local",
      "command": ["node", "./dist/index.js"],
      "enabled": true,
      "environment": {
        "HOST": "127.0.0.1",
        "PORT": "9222",
        "RELAY_MODE": "auto"
      }
    }
  }
}
```

Notes:
- No secrets/tokens are required.
- The MCP server communicates over stdio; OpenCode will launch it via the `command` array.

---

## Environment variables

- `HOST` (default: `127.0.0.1`)  
  Host for the relay HTTP/WS server.

- `PORT` (default: `9222`)  
  Port for the relay HTTP/WS server.

- `RELAY_MODE` (default: `auto`)  
  Controls whether the MCP server starts or attaches to the relay:
  - `auto`: probe `http://HOST:PORT/` first; if a relay is already running, **attach**. Otherwise **start** a relay.
    - If starting the relay fails with `EADDRINUSE`, it probes `http://HOST:PORT/` again (longer timeout). If the relay is reachable, it **attaches**; otherwise it rethrows the original error.
  - `start`: always start its own relay (will fail on port conflicts).
  - `connect`: never start; require an existing relay at `http://HOST:PORT/` (throws if unreachable).

---

## Usage examples (tool calls)

Typical flow: ensure the extension is connected → open/select a tab → navigate → interact → snapshot/screenshot.

### 1) Wait for the extension to connect

```json
{
  "tool": "dev_browser_ensure_extension_connected",
  "input": { "timeoutMs": 30000, "pollIntervalMs": 250 }
}
```

### 2) Open (or reuse) a named tab

```json
{
  "tool": "dev_browser_page_open",
  "input": { "name": "my-tab" }
}
```

### 3) Navigate

```json
{
  "tool": "dev_browser_goto",
  "input": {
    "url": "https://example.com",
    "waitUntil": "load",
    "timeoutMs": 30000
  }
}
```

### 4) Snapshot (AI-friendly DOM outline)

```json
{
  "tool": "dev_browser_snapshot",
  "input": {}
}
```

The snapshot includes `snapshotRef` identifiers you can use for click/type.

### 5) Click / type

Click by CSS selector:

```json
{
  "tool": "dev_browser_click",
  "input": { "selector": "button[type='submit']" }
}
```

Click by `snapshotRef` (from `dev_browser_snapshot` output):

```json
{
  "tool": "dev_browser_click",
  "input": { "snapshotRef": "e123" }
}
```

Type by CSS selector:

```json
{
  "tool": "dev_browser_type",
  "input": { "selector": "input[name='q']", "text": "hello", "clearFirst": true }
}
```

Type by `snapshotRef`:

```json
{
  "tool": "dev_browser_type",
  "input": { "snapshotRef": "e456", "text": "hello", "clearFirst": true }
}
```

### 6) Screenshot

```json
{
  "tool": "dev_browser_screenshot",
  "input": { "fullPage": false, "saveToFile": true }
}
```

If `saveToFile=true` (default), it writes a PNG under:

- `./.opencode/dev_browser/`

…and returns the **file path** (plus the image content).

---

## Tool list

- `dev_browser_relay_status` — Get relay status (`wsEndpoint`, `extensionConnected`, `mode`); in `auto` it will start or attach.
- `dev_browser_ensure_extension_connected` — Wait until `extensionConnected=true` (polls relay `/`).
- `dev_browser_pages_list` — List named pages registered in the relay.
- `dev_browser_page_open` — Get or create a named tab via the relay and select it for subsequent actions.
- `dev_browser_page_delete_mapping` — Delete a named page mapping in the relay.
- `dev_browser_goto` — Navigate the selected tab to a URL.
- `dev_browser_click` — Click an element by CSS selector or `snapshotRef` (from `dev_browser_snapshot`).
- `dev_browser_type` — Type into an input by CSS selector or `snapshotRef` (from `dev_browser_snapshot`).
- `dev_browser_wait_for_selector` — Wait for a selector on the selected tab.
- `dev_browser_evaluate` — Evaluate JavaScript in the selected tab context.
- `dev_browser_screenshot` — Take a PNG screenshot; writes to `./.opencode/dev_browser` and returns the file path.
- `dev_browser_snapshot` — Return an AI-friendly snapshot (YAML-ish) for the selected tab.

---

## Relationship to `dev-browser` (SawyerHood/dev-browser)

This project was built to expose the same core idea as [`SawyerHood/dev-browser`](https://github.com/SawyerHood/dev-browser) to MCP clients (OpenCode): **drive a real browser with persistent state** and provide **LLM-friendly DOM snapshots**.

### What we reuse / align with

- **Extension-mode CDP relay concept**: dev-browser has an “extension mode” where a local relay bridges CDP messages between an extension (`chrome.debugger`) and automation clients.
- **Named pages**: both systems expose a `POST /pages` abstraction to create/activate a named tab and return a `targetId`.
- **Snapshot refs**: dev-browser’s snapshot approach uses an injected script that returns a YAML-ish outline with stable `[ref=eN]` markers.

### What’s different here

- **Protocol surface**: dev-browser is distributed as a Claude Code plugin/skill; this repo is a standalone **MCP server** designed for OpenCode.
- **Control path**: instead of shipping a “skill client” API, this exposes discrete MCP tools (`dev_browser_goto`, `dev_browser_click`, etc.) that send CDP commands.
- **Relay ownership for multi-OpenCode**: this MCP supports `RELAY_MODE=auto` so multiple OpenCode instances can attach to a single relay process without crashing on `EADDRINUSE`.
- **Deterministic tab targeting**: actions are scoped to a specific Chrome tab via `targetId` + `Target.attachToTarget` sessions so separate OpenCode instances can reliably control different named tabs.

---

## Troubleshooting

### `extensionConnected=false`

- Ensure Chrome/Chromium is running and the dev-browser extension is installed/enabled.
- The extension must be able to connect to `ws://HOST:PORT/extension`.
- Run `dev_browser_relay_status` to confirm the relay is reachable and to see `extensionConnected`.

### `EADDRINUSE` / port conflicts

- `PORT=9222` is commonly used by other tooling (including Chrome remote debugging).
- Fix by choosing a different port:
  - set `PORT` (and keep it consistent for both relay + extension)
  - or set `RELAY_MODE=connect` if you intentionally run a relay elsewhere and want to attach.

### Multiple OpenCode instances / tab naming

- Prefer explicit, unique tab names via `dev_browser_page_open` (e.g. `"myproject-admin"`, `"myproject-patient"`).
- If you don’t pass `pageName` to tools, they operate on the “last selected” page; avoid collisions by always opening/selecting a named page per workspace/agent.

### Where screenshots are written

- By default, screenshots are saved to:
  - `./.opencode/dev_browser/`
- If you don’t see files, confirm your current working directory (OpenCode project root) and that `saveToFile=true`.
