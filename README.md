<h1 align="center">OpenEvidence MCP (Cookie Auth Fork)</h1>

<p align="center">
  Use OpenEvidence from Claude Code, Codex CLI, Antigravity CLI, Claude Desktop, Cursor, Cline, Continue, and any MCP-compatible client.
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-2d72d9"></a>
  <a href="https://github.com/bakhtiersizhaev/openevidence-mcp"><img alt="Based on upstream" src="https://img.shields.io/badge/upstream-bakhtiersizhaev%2Fopenevidence--mcp-181717?logo=github"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-1d9a5a"></a>
  <a href="https://www.npmjs.com/package/@modelcontextprotocol/sdk"><img alt="MCP SDK" src="https://img.shields.io/badge/MCP%20SDK-1.26.0-1d9a5a"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9.3-3178c6"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="Auth" src="https://img.shields.io/badge/auth-cookies.json-4f46e5">
  <img alt="No Playwright" src="https://img.shields.io/badge/no-Playwright-ef4444">
  <img alt="Unofficial" src="https://img.shields.io/badge/OpenEvidence-unofficial-yellow">
  <img alt="BibTeX" src="https://img.shields.io/badge/citations-BibTeX-0f766e">
  <img alt="Crossref" src="https://img.shields.io/badge/validation-Crossref-f97316">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-ready-6b7280">
  <img alt="Codex CLI" src="https://img.shields.io/badge/Codex%20CLI-ready-111827">
  <img alt="Antigravity CLI" src="https://img.shields.io/badge/Antigravity%20CLI-ready-8b5cf6">
</p>

## What It Does

This is an unofficial OpenEvidence MCP server that reuses cookies exported from your own logged-in OpenEvidence browser session. It does not launch a browser, does not install Playwright, and does not need an official OpenEvidence API key.

It is designed for local personal workflows where you already have lawful access to OpenEvidence. It does not bypass authentication, remove access controls, redistribute OpenEvidence content, or include OpenEvidence data in this repository.

Tools:

| Tool                          | Purpose                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `oe_auth_status`              | Check `/api/auth/me` with your cookie file                                                                                  |
| `oe_history_list`             | Read OpenEvidence history                                                                                                   |
| `oe_article_get`              | Fetch an article by id and save artifacts                                                                                   |
| `oe_ask`                      | Ask a question (requires the browser-extension relay), optionally wait, and save artifacts                                  |
| `oe_collections_list`         | List your collections                                                                                                       |
| `oe_collections_get`          | Get a collection (incl. nested questions[] = membership list)                                                               |
| `oe_collections_create`       | Create a collection (agent-managed names should start with `#`)                                                             |
| `oe_collections_add_article`  | Add a chat to a collection                                                                                                  |
| `oe_collections_db_init`      | Create the local SQLite mirror (idempotent)                                                                                 |
| `oe_collections_sync_history` | Pull /api/article/list into local SQLite chats table                                                                        |
| `oe_collections_sync_db`      | Refresh collections + memberships into SQLite                                                                               |
| `oe_collections_unsorted`     | Chats with no `#`-collection membership; structured JSON                                                                    |
| `oe_collections_summary`      | Counts + last sync timestamps                                                                                               |
| `oe_collections_classify`     | Auto-classify unsorted chats using log-odds-ratio signatures learned from your existing memberships + curated keyword rules |
| `oe_collections_bulk_apply`   | Mint missing `#`-collections + add memberships per `[{article_id, hashtags}]` plan                                          |

`oe_ask` and `oe_article_get` return BibTeX in the MCP response by default when artifacts are saved. Pass `include_bibtex: false` to keep the response smaller while still writing `citations.bib` to disk.

### Collections sync & auto-sort routine

`scripts/collection_sort.py` mirrors your chat history and collection memberships into a local SQLite (`~/.openevidence-mcp/db/oe.sqlite` by default; override with `OE_MCP_DB_PATH`). The companion routine `routines/collection-sort.md` walks an MCP client through syncing, surfacing unsorted chats, and applying multi-membership hashtag tags. The convention: collections whose name starts with `#` are agent-managed; collections without a leading hash are human-curated and the routine never touches them.

The same pipeline is exposed as MCP tools (`oe_collections_db_init`, `oe_collections_sync_history`, `oe_collections_sync_db`, `oe_collections_unsorted`, `oe_collections_summary`, `oe_collections_bulk_apply`) — the TS server shells out to `scripts/collection_sort.py` via `python3` (override with `OE_MCP_PYTHON`) so the DataDome-safe HTTP path stays canonical.

```bash
python scripts/collection_sort.py init
python scripts/collection_sort.py sync-history --full   # first time
python scripts/collection_sort.py sync-collections
python scripts/collection_sort.py list-unsorted --json  # routine reads this
python scripts/collection_sort.py summary
```

**Account-scoped (schema v2).** Chats, collections, and memberships carry an `account` column (composite primary keys), so one DB can mirror multiple OpenEvidence logins without mixing them. The account is resolved from `/api/auth/me` (the cookie's account); override with `--account EMAIL`. Sync/write commands always use the live account; offline reads (`list-unsorted`, `summary`) fall back to the sole account in the DB, then to a live lookup. An existing v1 DB auto-migrates on first open — pre-v2 rows are tagged `--legacy-account` (default `legacy`; or `OE_MCP_LEGACY_ACCOUNT`). `summary` reports the active `account` and `known_accounts`.

#### Schedule the sync (macOS)

The classification step needs the agent in the loop, but the sync side is pure I/O — install a daily launchd job that keeps the local SQLite mirror fresh so the next agent run has zero lag:

```bash
bash scripts/install_launchd.sh                  # daily 02:00 (override via OE_MCP_SYNC_HOUR / OE_MCP_SYNC_MINUTE)
launchctl start com.htlin.openevidence-mcp.sync  # fire once now to verify
tail -30 ~/.openevidence-mcp/logs/sync.log
bash scripts/install_launchd.sh --uninstall      # remove
```

The wrapper (`scripts/collection_sync_cron.sh`) appends one block per run to `~/.openevidence-mcp/logs/sync.log` containing the sync-history / sync-collections / summary output. Override the log dir with `OE_MCP_LOG_DIR`.

The wrapper takes an optional mode flag:

| Mode        | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| (default)   | sync only — chats accumulate as `unsorted` until you run the routine |
| `--dry-run` | sync + classify; writes `proposed-plan.json` for review, no apply    |
| `--auto`    | sync + classify + bulk-apply + reconcile; fully autonomous sort      |

`scripts/classify.py` runs offline, no API. It builds a per-tag log-odds-ratio signature (Monroe et al. 2008) from your existing memberships every run, OR'd with curated keyword rules. Validate quality on your data with `python scripts/classify.py validate` (held-out cross-validation; on the first 603 memberships I verified, hit-rate = 99.4% with recall ≈1.0; precision varies by tag — raise `--threshold` for tighter precision in `--auto` mode). Tune for headless use via `OE_MCP_AUTO_THRESHOLD` (default 12) and `OE_MCP_AUTO_TOP_K` (default 3). Switch the launchd job to autonomous mode with `OE_MCP_SYNC_MODE=--auto bash scripts/install_launchd.sh`.

Saved artifacts:

| File                       | Purpose                              |
| -------------------------- | ------------------------------------ |
| `article.json`             | Full OpenEvidence article payload    |
| `answer.md`                | Extracted markdown answer            |
| `citations.json`           | Parsed structured citations          |
| `citations.bib`            | BibTeX bibliography                  |
| `crossref-validation.json` | Post-hoc Crossref validation results |

## Fast Install

You need two private browser exports from the same logged-in OpenEvidence browser session:

| File                       | Purpose                                                | Where to put it                        |
| -------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `cookies.json`             | Authenticates your OpenEvidence account session        | `./cookies.json`                       |
| `www.openevidence.com.har` | Teaches the client the browser fingerprint that worked | Any private path; pass it as `HAR=...` |

Both files are credentials. Keep them local, do not commit them, and do not share them. The HAR extractor only saves the browser signature headers into `openevidence-fingerprint.json`; it does not copy cookies or authorization headers from the HAR.

```bash
git clone https://github.com/htlin222/openevidence-mcp.git
cd openevidence-mcp
npm install
```

Export cookies from a logged-in `https://www.openevidence.com` browser session and put them here:

```bash
cp /path/to/browser-cookies.json ./cookies.json
```

Export a HAR that contains a successful OpenEvidence ask request (`POST /api/article`, usually status `201`), then build:

```bash
make build HAR=/path/to/www.openevidence.com.har
npm run login
npm run smoke
```

> ⚠️ **Asking requires the browser extension.** `npm run smoke` validates auth + reads only (those work over cookies). `oe_ask` submits the request through a small Brave/Chrome relay extension that runs it inside your own logged-in tab — set it up **before asking**: see the **Browser extension relay** section below and [`extension/README.md`](extension/README.md). Reads (`oe_history_list`, `oe_article_get`, collections) work without it.

`make build` extracts `openevidence-fingerprint.json` from the HAR when the HAR exists, then compiles `dist/server.js`. The cookie file can be a browser-exported cookies array or a storage-state object with a `cookies` array.

The fingerprint is **profile-faithful**: the client sends exactly the captured browser's header set — no backfill from a built-in default. So a HAR from any browser works, and the headers stay coherent with the cookie that browser minted. A **Safari** HAR, for example, correctly sends Safari's `User-Agent` and `Sec-Fetch-*` and **omits** the Chromium-only `sec-ch-ua*` client hints (which Safari does not send); a Chrome/Brave HAR includes them. Match the fingerprint browser to the browser that exported `cookies.json` for the most coherent request. (The `make build` step still warns when a HAR lacks `sec-ch-ua*` — that warning is expected and harmless for Safari.)

For a private battery-included portable skill, also copy the same cookie file into the skill folder:

```bash
cp ./cookies.json ./openevidence-skill/cookies.json
```

That lets `openevidence-skill/scripts/oe.py` run standalone without MCP config. This is local-only; `openevidence-skill/cookies.json` is gitignored and should never be published in a public skill bundle.

## Register With MCP Clients

Use one of these.

### Claude Code

```bash
make install-claude-global HAR=/path/to/www.openevidence.com.har
claude mcp get openevidence
```

What it registers:

```text
node /ABSOLUTE/PATH/openevidence-mcp/dist/server.js
OE_MCP_COOKIES_PATH=/ABSOLUTE/PATH/openevidence-mcp/cookies.json
```

### Codex CLI

```bash
make install-codex-global HAR=/path/to/www.openevidence.com.har
codex mcp get openevidence
```

Equivalent manual command:

```bash
codex mcp add openevidence \
  --env OE_MCP_COOKIES_PATH="$PWD/cookies.json" \
  -- node "$PWD/dist/server.js"
```

Manual `~/.codex/config.toml`:

```toml
[mcp_servers.openevidence]
command = "node"
args = ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"]
startup_timeout_sec = 60

[mcp_servers.openevidence.env]
OE_MCP_COOKIES_PATH = "/ABSOLUTE/PATH/openevidence-mcp/cookies.json"
```

### Antigravity CLI (agy-cli)

```bash
make install-agy-global HAR=/path/to/www.openevidence.com.har
agy-cli mcp list
```

Equivalent manual command:

```bash
agy-cli mcp add --scope user \
  -e OE_MCP_COOKIES_PATH="$PWD/cookies.json" \
  openevidence node "$PWD/dist/server.js"
```

### Claude Desktop, Cursor, Cline, Continue

Use this `mcpServers` shape:

```json
{
  "mcpServers": {
    "openevidence": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"],
      "env": {
        "OE_MCP_COOKIES_PATH": "/ABSOLUTE/PATH/openevidence-mcp/cookies.json"
      }
    }
  }
}
```

### Install Everywhere

```bash
make install-all HAR=/path/to/www.openevidence.com.har
```

This registers the same local stdio server with Claude Code, Codex CLI, and Antigravity CLI.

## Verify

```bash
npm run check
npm test
npm run build
npm run smoke
```

Expected smoke result:

```json
{
  "ok": true,
  "authenticated": true
}
```

MCP stdio servers normally start on demand when the client checks or uses them. They do not need to run as a separate daemon.

### Doctor (stale DataDome cookie check)

If requests start failing with a DataDome 403 — most often **after moving to a different computer** — run the doctor:

```bash
npm run doctor              # static checks + a live read probe
npm run doctor -- --offline # static checks only (no network)
npm run doctor -- --json    # machine-readable output
```

It flags the common ways the `datadome` cookie goes stale:

- **`datadome-missing` / `datadome-expired` / `datadome-session`** — the cookie is absent, past its expiry, or session-scoped.
- **`fingerprint-platform-mismatch` (FAIL)** — the cookie + `openevidence-fingerprint.json` were minted on a different OS than the host. DataDome binds its token to the (UA + client-hints + IP + TLS) signature, so it will be re-challenged here. **Re-mint on this machine:** browser login → export `cookies.json` + HAR → `make build HAR=…`.
- **`fingerprint-default` (WARN)** — no `openevidence-fingerprint.json`; the built-in macOS/arm signature is in use.
- **`datadome-live` (FAIL)** — a live request was actually challenged (definitive staleness). Exit code is non-zero when any check fails, so it works in CI/pre-flight.

### Browser extension relay (required for `oe_ask` — invisible, no 403)

A small companion **Chromium extension** — works in Chrome, Edge, Brave, Arc, Vivaldi, Opera — removes the DataDome problem entirely: the MCP server submits the ask `POST` **inside your real logged-in tab** (genuine origin/cookies/TLS), with **no visible navigation**. It's a generic authenticated fetch proxy — all logic stays in Node; the extension just lends its browser session over a localhost relay. The call is handled by **whichever browser has the extension installed and is logged into OpenEvidence**, so install it in the browser you use for OpenEvidence (and run it in one browser at a time).

Install (one time):

1. Download from the [**extension release**](https://github.com/htlin222/openevidence-mcp/releases/tag/extension-v0.1.0) — grab the `…-relay-extension-*.zip` and unzip (or build from source: `cd extension && npm install && npm run build`).
2. Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, `brave://extensions`, …) → **Developer mode** → **Load unpacked** → select the unzipped (or `extension/dist/`) folder.
3. Stay **logged in to openevidence.com** in that browser, then run the MCP server — it auto-connects.

Then `oe_ask` submits through the extension (it is the only ask path). Set `OE_MCP_RELAY_TRANSPORT=all` to route **every** request through the extension's session — `cookies.json` becomes optional. Check the link: `curl http://127.0.0.1:8787/health`. Full docs: [`extension/`](extension/README.md).

> The release also ships a signed `.crx`; note Chromium browsers block `.crx` files loaded from outside the Web Store, so **Load unpacked from the zip** is the normal install. The `.crx` is for enterprise-policy / reference use.

## How To Ask Questions

After registration, ask your MCP client in plain English and mention OpenEvidence. The agent should call `oe_ask` automatically.

Example prompts:

```text
Use OpenEvidence to answer: DLBCL frontline treatment landscape NCCN v3.2026. Include citations and BibTeX.
```

```text
Use OpenEvidence to compare Pola-R-CHP vs R-CHOP in untreated DLBCL. Include trial citations and BibTeX.
```

```text
Use OpenEvidence to review current evidence for SGLT2 inhibitors in HFpEF. Include citations and BibTeX.
```

```text
Use OpenEvidence to find guideline-supported anticoagulation options for cancer-associated thrombosis.
```

The underlying MCP call looks like this:

```json
{
  "tool": "oe_ask",
  "arguments": {
    "question": "DLBCL frontline treatment landscape NCCN v3.2026",
    "wait_for_completion": true,
    "include_bibtex": true
  }
}
```

`oe_ask` returns:

- the OpenEvidence article payload
- `article_id`
- extracted answer markdown as `extracted_answer_raw`
- artifact file paths
- inline BibTeX as `artifacts.bibtex`
- saved citation files under the artifact directory

To fetch BibTeX for a prior answer, ask:

```text
Use OpenEvidence to fetch article <ARTICLE_ID> and show the BibTeX.
```

That maps to `oe_article_get`:

```json
{
  "article_id": "<ARTICLE_ID>",
  "include_bibtex": true
}
```

If the response is too large, use `include_bibtex: false`; the server will still write `citations.bib` to disk.

## Citation Artifacts

Completed `oe_ask` and `oe_article_get` calls save artifacts under:

```text
/tmp/openevidence-mcp/<article_id>/
```

On macOS, Node may resolve `/tmp` to a path under `/var/folders/.../T/`.

Example output:

```text
answer.md
article.json
citations.json
citations.bib
crossref-validation.json
```

Crossref validation behavior:

- DOI citations are validated directly with Crossref.
- Non-DOI citations use a bibliographic query and are marked as `candidate`, `not_found`, or `error`.
- Low-similarity Crossref matches are not used to overwrite BibTeX metadata.
- Sources like NCCN guidelines may stay as local OpenEvidence metadata because Crossref often has no authoritative match.

## Copyright, Trademark, And Medical Disclaimer

This project is unofficial and independent. It is not affiliated with, endorsed by, sponsored by, or approved by OpenEvidence or its owners. "OpenEvidence" and related names, logos, product names, and content remain the property of their respective owners.

This repository contains connector code only. It does not include OpenEvidence copyrighted content, proprietary datasets, model outputs, article payloads, session cookies, or account material. Your local use of this MCP server may create files such as `answer.md`, `article.json`, and `citations.bib`; those artifacts can contain content retrieved from or derived from your OpenEvidence account session. Treat those files as private unless you have the right to share them.

You are responsible for complying with OpenEvidence terms, institutional policies, copyright law, and any clinical data governance rules that apply to your use. Do not publish cookies, account tokens, saved article payloads, generated answers, screenshots, guideline text, or other protected/copyrighted content unless you have permission or another valid legal basis.

This software is not medical advice and is not a medical device. It is an integration tool for an MCP client. Clinicians and qualified users remain responsible for verifying outputs against authoritative sources and applying independent clinical judgment.

## Cookie Refresh

If auth stops working:

```bash
cp /path/to/fresh-browser-cookies.json ./cookies.json
npm run login
```

Then restart or open a fresh MCP client session if the old stdio server process is still alive.

## Make Targets

| Target                                              | Purpose                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `make deps`                                         | Run `npm install`                                                     |
| `make build HAR=/path/to/file.har`                  | Extract fingerprint if the HAR exists, then compile TypeScript        |
| `make check`                                        | Type-check                                                            |
| `make test`                                         | Run unit tests                                                        |
| `make smoke`                                        | Validate auth and history access                                      |
| `make fingerprint HAR=/path/to/file.har`            | Extract the working browser fingerprint from a HAR                    |
| `make import-cookies COOKIES=/path/to/cookies.json` | Import and verify cookies                                             |
| `make install-claude-global HAR=/path/to/file.har`  | Build, then register with Claude Code user config                     |
| `make install-codex-global HAR=/path/to/file.har`   | Build, then register with Codex CLI                                   |
| `make install-agy-global HAR=/path/to/file.har`     | Build, then register with Antigravity CLI user config                 |
| `make install-all HAR=/path/to/file.har`            | Build, then register with Claude Code, Codex CLI, and Antigravity CLI |

## Environment Variables

| Variable                   | Default                                                                   | Purpose                                           |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `OE_MCP_BASE_URL`          | `https://www.openevidence.com`                                            | OpenEvidence base URL                             |
| `OE_MCP_ROOT_DIR`          | `~/.openevidence-mcp`                                                     | Root for default auth paths                       |
| `OE_MCP_COOKIES_PATH`      | `./cookies.json` if present, else `~/.openevidence-mcp/auth/cookies.json` | Cookie file                                       |
| `OE_MCP_AUTH_STATE_PATH`   | unset                                                                     | Legacy alias for `OE_MCP_COOKIES_PATH`            |
| `OE_MCP_FINGERPRINT_PATH`  | `./openevidence-fingerprint.json` if present                              | Browser signature header fingerprint              |
| `OE_MCP_ARTIFACT_DIR`      | OS temp dir + `openevidence-mcp`                                          | Artifact output directory                         |
| `OE_MCP_CROSSREF_MAILTO`   | unset                                                                     | Optional Crossref polite-pool email               |
| `OE_MCP_CROSSREF_VALIDATE` | `1`                                                                       | Set `0` to skip Crossref validation               |
| `OE_MCP_POLL_INTERVAL_MS`  | `1200`                                                                    | Poll interval for `oe_ask`                        |
| `OE_MCP_POLL_TIMEOUT_MS`   | `180000`                                                                  | Default poll timeout                              |
| `OE_MCP_DB_PATH`           | `~/.openevidence-mcp/db/oe.sqlite`                                        | Local SQLite mirror used by the collections tools |
| `OE_MCP_PYTHON`            | `python3`                                                                 | Python interpreter the bridge tools spawn         |
| `OE_MCP_LEGACY_ACCOUNT`    | `legacy`                                                                  | Label for pre-v2 rows on DB account migration     |

## Project Files

- [README.AI.md](README.AI.md) - agent install playbook
- [examples/codex-config.toml](examples/codex-config.toml) - Codex MCP config
- [examples/claude-desktop-config.json](examples/claude-desktop-config.json) - JSON MCP config
- [src/citations.ts](src/citations.ts) - citation extraction, BibTeX, Crossref validation
- [src/cookies.ts](src/cookies.ts) - cookie file parsing
- [src/server.ts](src/server.ts) - MCP tools
- [src/relay-server.ts](src/relay-server.ts) - localhost relay the browser extension connects to
- [src/doctor.ts](src/doctor.ts) - stale DataDome cookie diagnostics
- [extension/README.md](extension/README.md) - browser-extension relay (required for `oe_ask`)
- [test/citations.test.ts](test/citations.test.ts) - unit tests

## License And Attribution

Apache-2.0. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing.

Based on OpenEvidence MCP by Bakhtier Sizhaev: `https://github.com/bakhtiersizhaev/openevidence-mcp`
