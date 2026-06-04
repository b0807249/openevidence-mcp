# Browser-fallback ask: ask OpenEvidence from a Claude Code session without DataDome 403

**Date:** 2026-06-04 · **Branch:** `relay-ask`

## Goal

From a Claude Code / MCP session, ask OpenEvidence and get the answer back —
**without ever hitting a DataDome (CF) 403** — by mimicking real browser behaviour:
ask by GET (let the browser fire its own POST), fire-and-forget, then poll with
`cookies.json` to recover the chat id and fetch the result.

## What we verified (live, 2026-06-04)

1. **`GET /ask?query=…&_rsc=…` passes DataDome from Node** (200, `x-datadome:
   protected`) but **does NOT create an article** — it only renders the page shell
   with the query pre-filled. The article is created by the *client-side* `POST
   /api/article`, which is the path DataDome scores aggressively. (`rsc-get-probe`,
   now removed.)
2. **`open <askUrl>` works end-to-end**: the real browser GETs the page, its JS
   fires the POST with the browser's genuine TLS/JA3 fingerprint → DataDome passes
   → article created → URL becomes `/ask/<id>`. Node never touches the POST. We
   recover everything via `cookies.json` GETs. Proven: `scripts/open-url-probe.mjs`
   created a real article, `status: success`, in ~18s.
3. **Both ask paths return full clinical answers** (3000–3400 chars, NCCN
   citations) through the built code: `scripts/ask-fallback-e2e.mjs` (happy Node
   POST) and the same with `force` (browser fallback).

## Why "just use GET" / "just fetch in Node" can't work

`open url` is not an HTTP request — it hands the URL to the **browser**, which
*runs the page's JavaScript* and that JS fires the POST. Node `fetch` only does the
bare GET; it has no JS engine, so the POST never fires and no article is created.
"Mimic the browser" therefore means **drive the real browser**, which is exactly
what `askViaBrowser` does (`open`/AppleScript) — not replay the POST in Node.

The WebSocket-relay / persistent-tab / userscript design was explored and
**dropped**: `open <url>` + history-poll already mimics the browser, with no extra
daemon, socket, or userscript to maintain.

## What shipped

The repo already had `askViaBrowser` (`src/ask-browser.ts`) and an `oe_ask
via_browser=true` flag. Two changes make it the seamless default:

1. **Automatic fallback** (`src/server.ts`, `oe_ask`): try the Node `POST
   /api/article`; on `DataDomeChallengeError`, automatically re-issue through the
   real browser (`runViaBrowser`) instead of surfacing the 403. The browser fires
   the POST; the new id is recovered by diffing `/api/article/list` (a GET, never
   blocked); `waitForArticle` polls the answer. `via_browser=true` still forces the
   browser path explicitly.
2. **Config** (`src/config.ts`): `browserFallback` (env `OE_MCP_BROWSER_FALLBACK`,
   on by default; `=0` to fail fast on headless hosts).
3. **Robust tab open** (`src/ask-browser.ts`, `defaultOpenUrl`): the background
   AppleScript can raise an AppleEvent timeout (`-1712`) on a busy browser; we now
   degrade to the reliable `open -g <url>` instead of failing the ask.
4. **Reuse one OE tab** (`src/ask-browser.ts`, `backgroundTabScript`): instead of
   opening a new tab per ask, the AppleScript finds an existing openevidence.com
   tab and navigates it in place (a background tab nav steals neither focus nor the
   active-tab slot). It only opens a fresh tab when none exists; the tab stays on
   openevidence.com (`/ask/<id>`) so it keeps being reused. Quietest when pointed at
   a browser you don't actively use (`OE_MCP_BROWSER_APP`).

### Flow

```
oe_ask {question}
  └─ client.ask()  ── POST /api/article (Node) ──► success?  ──► waitForArticle ──► answer
                         │ DataDomeChallengeError (403)
                         ▼  (browserFallback)
                    askViaBrowser: open <…/ask?query=…> in the real logged-in browser
                         │ browser fires its own POST (real TLS ⇒ DataDome passes)
                         ▼
                    diff /api/article/list ──► new id ──► waitForArticle ──► answer
```

## Browser-extension relay (preferred quiet path)

The open-url path works but opens/navigates a visible tab. The **extension relay**
makes the same browser-issued POST with **no visible navigation** and recovers the
article id deterministically.

- `src/relay-server.ts` — an in-process, localhost-only HTTP relay (no `ws` dep).
  The extension long-polls `GET /poll` (the held request both delivers the next
  ask and keeps the MV3 service worker alive); `submitAsk(body)` resolves when the
  extension `POST /result`s the new article id. Started eagerly on server boot;
  `OE_MCP_RELAY=0` disables, `OE_MCP_RELAY_PORT` sets the port (default 8787).
- `extension/` — MV3 extension for Brave/Chrome. The service worker keeps one
  **pinned, background OpenEvidence tab tracked by tab id** (so it never collides
  with an OE tab you opened yourself) and runs `POST /api/article` *inside* it via
  `chrome.scripting` — page-context origin/cookies/TLS ⇒ DataDome passes — then
  returns `data.id`. No per-ask navigation; the tab just sits on openevidence.com.
- `oe_ask` fallback order on a DataDome 403: **extension relay (if connected)** →
  open-url browser (`browserFallback`) → throw. `buildAskBody` (in
  `openevidence-client.ts`) is shared so the relay submits a byte-identical body.

Install: load `extension/` unpacked (Developer mode), stay logged in to OE. See
`extension/README.md`. The full DataDome-bypass-via-extension is verified by you
in the live browser; the relay plumbing is unit-tested headlessly.

## Tests / verification

- `npm run check` + `npm run build` clean; `npm test` 57/57 pass.
- Manual e2e: `node scripts/ask-fallback-e2e.mjs <tag>` (happy path) and
  `… <tag> force` (forced fallback) — both return full answers.
- `node scripts/open-url-probe.mjs <tag>` — minimal open-url + poll proof.

## Operational note

The currently-running MCP server is a **stale build** (its `oe_ask` schema lacks
`via_browser`). Restart the MCP server so it loads the rebuilt `dist/` to pick up
the auto-fallback. Requires a GUI session with a logged-in default browser.
