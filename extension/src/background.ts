// OpenEvidence MCP Relay — MV3 service worker (TypeScript source).
//
// A generic authenticated fetch proxy. Long-polls the local relay (GET /poll);
// when the MCP server hands us {method, path, body}, we run that fetch INSIDE a
// parked OpenEvidence tab (page-context origin/cookies/TLS — DataDome passes) and
// post the raw {status, body} back to /result. All OpenEvidence logic stays in
// Node; this worker just lends it the browser's authenticated network stack.
//
// The continuous long-poll keeps this service worker alive; a 1-minute alarm
// restarts the loop if the worker was ever evicted.

// Injected by the build (esbuild `define`) so it matches OE_MCP_RELAY_PORT.
declare const __RELAY_PORT__: number;

const RELAY_BASE = `http://127.0.0.1:${__RELAY_PORT__}`;
const OE_BASE = "https://www.openevidence.com";
const OE_TAB_KEY = "oeRelayTabId";

let polling = false;

interface RelayRequest {
  method: string;
  path: string;
  body?: string;
}

interface InTabResult {
  status: number;
  body: string;
  error?: string;
}

// ---- dedicated tab management -------------------------------------------------

async function getStoredTabId(): Promise<number | undefined> {
  const o = await chrome.storage.session.get(OE_TAB_KEY);
  return o[OE_TAB_KEY] as number | undefined;
}

async function setStoredTabId(id: number): Promise<void> {
  await chrome.storage.session.set({ [OE_TAB_KEY]: id });
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete" && (t.url ?? "").startsWith(OE_BASE)) return;
    if (Date.now() > deadline) throw new Error("dedicated OE tab did not finish loading in time");
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Returns the id of a dedicated, logged-in OpenEvidence tab, creating a pinned
// background one if needed. Tracked by tab id (not URL), so it never collides
// with an OpenEvidence tab you opened yourself.
async function ensureOeTab(): Promise<number> {
  const stored = await getStoredTabId();
  if (stored != null) {
    try {
      const t = await chrome.tabs.get(stored);
      if ((t.url ?? "").startsWith(OE_BASE)) return stored;
      await chrome.tabs.update(stored, { url: `${OE_BASE}/` });
      await waitForTabComplete(stored);
      return stored;
    } catch {
      // tab was closed; create a fresh one below.
    }
  }
  const created = await chrome.tabs.create({ url: `${OE_BASE}/`, pinned: true, active: false });
  const id = created.id;
  if (id == null) throw new Error("failed to create OE tab");
  await setStoredTabId(id);
  await waitForTabComplete(id);
  return id;
}

// ---- the in-tab fetch ---------------------------------------------------------

// Serialized and run INSIDE the OpenEvidence tab — keep it self-contained.
function inTabProxy(req: RelayRequest): Promise<InTabResult> {
  const init: RequestInit = { method: req.method, credentials: "include" };
  if (req.body != null) {
    init.body = req.body;
    init.headers = { "content-type": "application/json" };
  }
  return fetch(req.path, init)
    .then((r) => r.text().then((body) => ({ status: r.status, body })))
    .catch((e) => ({ status: 0, body: "", error: String(e) }));
}

async function runProxy(req: RelayRequest): Promise<InTabResult> {
  const tabId = await ensureOeTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inTabProxy,
    args: [req],
  });
  const out = injection?.result as InTabResult | undefined;
  if (!out) throw new Error("no result from in-tab fetch");
  if (out.error) throw new Error(out.error);
  return out; // pass status/body through verbatim; Node decides on 4xx/5xx
}

// ---- relay loop ---------------------------------------------------------------

async function postResult(payload: {
  reqId: string;
  status?: number;
  body?: string;
  error?: string;
}): Promise<void> {
  try {
    await fetch(`${RELAY_BASE}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // server gone; nothing to do.
  }
}

async function handleRequest(reqId: string, req: RelayRequest): Promise<void> {
  try {
    const { status, body } = await runProxy(req);
    await postResult({ reqId, status, body });
  } catch (e) {
    await postResult({ reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`${RELAY_BASE}/poll`, { method: "GET" });
  if (res.status === 200) {
    const { reqId, req } = (await res.json()) as { reqId: string; req: RelayRequest };
    void handleRequest(reqId, req); // don't block the next poll
  } else {
    await res.text().catch(() => "");
  }
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      try {
        await pollOnce();
      } catch {
        await new Promise((r) => setTimeout(r, 2000)); // relay not up yet / transient
      }
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onStartup.addListener(() => void pollLoop());
chrome.runtime.onInstalled.addListener(() => void pollLoop());
chrome.alarms.create("oe-relay-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oe-relay-keepalive") void pollLoop();
});

void pollLoop();
