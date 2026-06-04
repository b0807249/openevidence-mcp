# OpenEvidence MCP Relay (Brave/Chrome extension)

Lets the MCP server submit OpenEvidence asks **from inside your real logged-in
tab**, so the `POST /api/article` carries the browser's genuine origin, cookies,
and TLS fingerprint — DataDome passes — while everything else stays on Node.

It is **localhost-only**: the extension talks to `http://127.0.0.1:8787` (the
relay the MCP server runs) and never to any third party.

## How it works

```
oe_ask ──► MCP server ── Node POST /api/article ──► (DataDome 403?)
                              │ yes, and extension connected
                              ▼
                      relay (http://127.0.0.1:8787)
                              │ GET /poll (long-poll, keeps the worker alive)
                              ▼
                      extension service worker
                              │ runs POST /api/article INSIDE a pinned OE tab
                              ▼  (real origin/cookies/TLS ⇒ DataDome passes)
                      reads the new article id ── POST /result ──► relay
MCP server ◄── article id ── relay ;  then polls the answer over Node (cookies.json)
```

The extension keeps **one pinned, background OpenEvidence tab** (tracked by tab
id, so it never touches an OE tab you opened yourself) and runs the POST there.
You won't see any navigation; the tab just sits on openevidence.com.

## Install (one time)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Make sure you are **logged in to openevidence.com** in this same browser.

That's it. The service worker auto-connects to the relay and re-connects on
browser restart. When it first runs the in-tab POST, Brave may ask once to allow
the extension to access openevidence.com — allow it.

## Use

- Start (or restart) the OpenEvidence MCP server so it picks up the relay build.
- Ask as usual (`oe_ask`). If the Node POST is DataDome-blocked, the server
  routes it through the extension automatically — no flag needed.
- The first ask creates the pinned OE tab; leave it open (it's reused).

## Config

- Relay port: `OE_MCP_RELAY_PORT` on the server (default `8787`). If you change
  it, update `RELAY_BASE` at the top of `background.js` to match.
- Disable the relay entirely: `OE_MCP_RELAY=0` on the server.

## Checking it's connected

With the server running: `curl http://127.0.0.1:8787/health` →
`{"ok":true,"connected":true,...}` once the extension is polling.
