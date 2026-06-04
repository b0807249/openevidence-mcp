<h1 align="center">OpenEvidence MCP - AI Agent Install Playbook</h1>

<p align="center">
  Runbook for Codex, Claude Code, and similar agents to install and validate OpenEvidence MCP end-to-end.
</p>

<p align="center">
  <a href="README.md">Human Guide</a> •
  <a href="https://github.com/htlin222/openevidence-mcp">Live Docs</a> •
  <a href="docs/SEMANTIC_CORE.md">Semantic Core</a>
</p>

## Goal

Install and validate OpenEvidence MCP on macOS, Windows, or Ubuntu via a single `make all`. The browser-extension relay is the login: all MCP requests route through a logged-in Chromium tab, so no cookies are required for the default flow.

## Scope

- Agent checks runtime and MCP availability
- Agent installs missing dependencies
- Agent runs `make all` (builds server + extension, registers Claude & Codex)
- Human loads the unpacked extension and stays logged into openevidence.com
- Agent verifies MCP tools are live

## Step 0: Detect Environment

- OS: macOS, Windows, Ubuntu/Linux
- Host client:
  - Codex CLI
  - Claude Desktop / Claude Code
  - Other MCP client

## Step 1: Install OpenEvidence MCP Repo

### macOS

```bash
cd /path/where/repo/should/live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
./scripts/setup-macos.sh
```

### Ubuntu/Linux

```bash
cd /path/where/repo/should/live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
./scripts/setup-ubuntu.sh
```

### Windows (PowerShell)

```powershell
cd C:\path\where\repo\should\live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
.\scripts\setup-windows.ps1
```

## Step 2: Install & Register (`make all`)

This is the primary install path. One command installs deps, builds the server + extension, and registers the MCP into both Claude and Codex (it skips any CLI that is not installed):

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
make all   # equivalent to bare `make`
```

`make all` performs, in order:
- `npm install` (deps)
- build the MCP server (`dist/server.js`)
- build the browser extension (`extension/dist`)
- register the MCP into Claude Code/Desktop and Codex CLI

Run `make help` to list all targets. The per-client registration targets still exist for à la carte use (e.g. `make install-claude-global`, `make install-codex`) — `make all` already invokes them.

Verify registration:

```bash
claude mcp get openevidence    # if Claude CLI is installed
```

## Step 3: Load the Browser Extension (the login)

The browser extension IS the login — all MCP requests relay through a logged-in Chromium tab. Ask the human to:

1. Open `chrome://extensions` in any Chromium browser (Chrome, Edge, Brave, Arc, Vivaldi, Opera)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select `/ABSOLUTE/PATH/openevidence-mcp/extension/dist`
4. Log in at `https://www.openevidence.com` and keep that tab/session open

The relay daemon is auto-spawned by the server and shared across sessions (see Relay architecture below), so one logged-in tab serves many concurrent Claude/Codex sessions.

## Step 4: Validate

MCP-side checks:
- `oe_auth_status`
- `oe_history_list`
- `oe_ask` → `oe_article_get`

`oe_ask` is **fire-and-forget by default**: it returns `{ article_id, status: "pending" }` immediately. Fetch the finished answer with `oe_article_get(article_id)` — it supports `wait_for_completion` / `timeout_sec` / `poll_interval_ms` and reports `status`. For a one-shot blocking call, pass `oe_ask(wait_for_completion: true)`.

`oe_ask` and `oe_article_get` include `artifacts.bibtex` in their MCP response by default when artifacts are saved. Use `include_bibtex: false` if the client needs a smaller response.

## Step 5: Optional — Cookie Handoff (legacy / Python tooling)

Cookies are **optional**. They are only needed for:
- the legacy cookie read path (`OE_MCP_RELAY_TRANSPORT=off`)
- the Python collections tooling
- `npm run doctor` / `npm run login` / `npm run smoke`

If you need any of those, ask the user to export cookies from a logged-in `https://www.openevidence.com` session and place them at `/ABSOLUTE/PATH/openevidence-mcp/cookies.json`, then:

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
npm run login
# or: npm run import-cookies -- --import /path/to/cookies.json
```

## Step 6: Recovery Paths

- **Primary (relay) auth recovery**: ensure the extension is loaded, the openevidence.com tab is logged in, and the relay daemon is up. Check `http://127.0.0.1:8787/health` (returns version + pid).
- If MCP tool not visible: restart client session/app
- If dependencies break: rerun `make all`
- **Legacy fallback only** (cookie path / Python tooling): export fresh cookies and rerun `npm run login`

## Relay Architecture

- The relay is a **shared standalone daemon on port `8787`**, auto-spawned by the MCP server.
- It **outlives every session** — many Claude/Codex sessions run concurrently through ONE logged-in browser tab.
- The browser extension is the login; any Chromium browser works (Chrome, Edge, Brave, Arc, Vivaldi, Opera).
- `GET /health` returns the relay `version` + `pid`.
- Env vars: `OE_MCP_RELAY_PID_PATH` (daemon pid file), `OE_MCP_RELAY_LOG_PATH` (daemon log file), `OE_MCP_RELAY_TRANSPORT=off` (disable relay, use the legacy cookie read path).
- Stop everything (all servers + the relay daemon): `make kill-all`.

## Clean Repository Rules for Agents

- Do not commit user session files
- Do not commit `.env` with secrets
- Keep `.gitignore` intact
- Keep reusable examples in `examples/`
- Preserve parser files in `docs/`
- Preserve attribution: keep `LICENSE` and `NOTICE`
