// OpenEvidence MCP Relay — MV3 service worker (TypeScript source).
//
// Long-polls the local relay (GET /poll). When the MCP server hands us an ask
// body, we run POST /api/article INSIDE a parked OpenEvidence tab (page-context
// origin/cookies/TLS — DataDome passes), read the new article id from the
// response, and POST it back to /result.
//
// The continuous long-poll keeps this service worker alive; a 1-minute alarm
// restarts the loop if the worker was ever evicted.

// Injected by the build (esbuild `define`) so it matches OE_MCP_RELAY_PORT.
declare const __RELAY_PORT__: number;

const RELAY_BASE = `http://127.0.0.1:${__RELAY_PORT__}`;
const OE_BASE = "https://www.openevidence.com";
const OE_TAB_KEY = "oeRelayTabId";

let polling = false;

interface InTabResult {
  status: number;
  text: string;
  error?: string;
}

// ---- dedicated tab management -------------------------------------------------

async function getStoredTabId(): Promise<number | undefined> {
  const o = await chrome.storage.session.get(OE_TAB_KEY);
  return o[OE_TAB_KEY] as number | undefined;
}

async function setStoredTabId(id: number | undefined): Promise<void> {
  await chrome.storage.session.set({ [OE_TAB_KEY]: id });
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async (): Promise<void> => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete" && (t.url ?? "").startsWith(OE_BASE)) {
          resolve(t);
          return;
        }
      } catch (e) {
        reject(e);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("dedicated OE tab did not finish loading in time"));
        return;
      }
      setTimeout(tick, 400);
    };
    void tick();
  });
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

// ---- the in-tab POST ----------------------------------------------------------

// Serialized and run INSIDE the OpenEvidence tab — keep it self-contained.
function inTabAsk(body: unknown): Promise<InTabResult> {
  return fetch("/api/article", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  })
    .then((r) => r.text().then((text) => ({ status: r.status, text })))
    .catch((e) => ({ status: 0, text: "", error: String(e) }));
}

async function runAskInTab(body: unknown): Promise<string> {
  const tabId = await ensureOeTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inTabAsk,
    args: [body],
  });
  const out = injection?.result as InTabResult | undefined;
  if (!out) throw new Error("no result from in-tab fetch");
  if (out.error) throw new Error(out.error);
  if (out.status === 403) throw new Error("DataDome 403 even from the tab (re-auth in the browser)");
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`POST /api/article -> ${out.status} ${out.text.slice(0, 200)}`);
  }
  let data: { id?: string; article_id?: string };
  try {
    data = JSON.parse(out.text);
  } catch {
    throw new Error("POST /api/article returned non-JSON");
  }
  const articleId = data.id ?? data.article_id;
  if (!articleId) throw new Error("POST /api/article returned no id");
  return String(articleId);
}

// ---- relay loop ---------------------------------------------------------------

async function postResult(payload: { reqId: string; articleId?: string; error?: string }): Promise<void> {
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

async function handleAsk(reqId: string, body: unknown): Promise<void> {
  try {
    const articleId = await runAskInTab(body);
    await postResult({ reqId, articleId });
  } catch (e) {
    await postResult({ reqId, error: e instanceof Error ? e.message : String(e) });
  }
}

async function pollOnce(): Promise<void> {
  const res = await fetch(`${RELAY_BASE}/poll`, { method: "GET" });
  if (res.status === 200) {
    const { reqId, body } = (await res.json()) as { reqId: string; body: unknown };
    void handleAsk(reqId, body); // don't block the next poll
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
