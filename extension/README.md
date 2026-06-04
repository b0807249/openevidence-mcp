# OpenEvidence MCP Relay (Chromium extension)

Works on **any Chromium-based browser** — Chrome, Edge, Brave, Arc, Vivaldi,
Opera. It's a standard MV3 extension (`chrome.*` APIs only); the same unpacked
folder / `.crx` loads in all of them.

It lets the MCP server run OpenEvidence requests **from inside your own logged-in
tab**, so they carry the browser's genuine origin, cookies, and TLS — DataDome
sees a normal session. It is a **generic authenticated fetch proxy**: it runs
whatever `{method, path, body}` the server hands it and returns `{status, body}`.
All OpenEvidence logic stays in Node.

It is **localhost-only**: the extension talks to `http://127.0.0.1:8787` (the
relay the MCP server runs) and never to any third party.

## How it works

```
oe_ask ──► MCP server ── relay.request(POST /api/article) ──► relay (127.0.0.1:8787)
                                                                   │ GET /poll (long-poll;
                                                                   │ also keeps the worker alive)
                                                                   ▼
                                                       extension service worker
                                                                   │ runs the fetch INSIDE a
                                                                   │ pinned OpenEvidence tab
                                                                   ▼  (real origin/cookies/TLS)
                                                       reads {status, body} ─ POST /result ─► relay
MCP server ◄── article id ── relay ;  then polls the answer (Node GET, or via the relay)
```

The extension keeps **one pinned, background OpenEvidence tab** (tracked by tab
id, so it never touches a tab you opened yourself) and runs the request there.
No visible navigation — the tab just sits on openevidence.com.

## Which browser handles a call

The request is handled by **whichever browser has this extension installed and is
logged in to openevidence.com** — that browser connects to the relay and answers.
So you choose your browser simply by installing the extension there.

- **Install it in the browser you're logged into OpenEvidence with.** The in-tab
  request uses *that* browser's session; if that browser isn't logged in, the call
  fails with a 401/403 (the server says so).
- **Use one browser at a time.** If two browsers run the extension simultaneously,
  a request goes to whichever polls first — which may not be the logged-in one.
  To switch browsers, load the extension in the new one (and remove/disable it in
  the old one).

## Build

Standalone sub-project (own `package.json`; the root `openevidence-mcp` package
carries none of its build deps). Build the loadable artifact into `extension/dist/`:

```
make extension          # from the repo root (runs npm install + build here)
# or, inside extension/:
npm install && npm run build
```

`npm run check` typechecks. The relay port is baked in from `OE_MCP_RELAY_PORT`
(default `8787`) — rebuild if you change it.

## Install (one time)

1. Build it (above) so `extension/dist/` exists — or download the zip from the
   [extension release](https://github.com/htlin222/openevidence-mcp/releases/tag/extension-v0.1.0).
2. Open your browser's extensions page (`chrome://extensions`, `edge://extensions`,
   `brave://extensions`, …).
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select the **`extension/dist/`** folder.
5. Make sure you are **logged in to openevidence.com** in *this* browser.

The service worker auto-connects to the relay and reconnects on browser restart.
On its first in-tab request the browser may ask once to allow access to
openevidence.com — allow it.

## Use

- Start (or restart) the MCP server so it runs the relay.
- Ask as usual (`oe_ask`). The server submits the POST through this extension; if
  no extension is connected, `oe_ask` fails fast with this guidance.
- The first ask creates the pinned OE tab; leave it open (it's reused).

## Config

- Relay port: `OE_MCP_RELAY_PORT` on the server (default `8787`), baked into the
  extension at build time — set it before `make extension` and rebuild + reload if
  you change it.
- Disable the relay entirely: `OE_MCP_RELAY=0` on the server.

## Checking it's connected

With the server running: `curl http://127.0.0.1:8787/health` →
`{"ok":true,"connected":true,...}` once the extension is polling.
