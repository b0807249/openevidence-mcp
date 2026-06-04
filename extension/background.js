// OpenEvidence MCP Relay — MV3 service worker.
//
// Long-polls the local relay (GET /poll). When the MCP server hands us an ask
// body, we run the POST /api/article INSIDE a parked OpenEvidence tab (a content
// script, so it carries the page's real origin/cookies/TLS — DataDome passes),
// read the new article id from the response, and POST it back to /result.
//
// The continuous long-poll fetch keeps this service worker alive; a 1-minute
// alarm restarts the loop if the worker was ever evicted.

const RELAY_BASE = "http://127.0.0.1:8787";
const OE_BASE = "https://www.openevidence.com";
const OE_TAB_KEY = "oeRelayTabId";

let polling = false;

// ---- dedicated tab management -------------------------------------------------

async function getStoredTabId() {
  const o = await chrome.storage.session.get(OE_TAB_KEY);
  return o[OE_TAB_KEY];
}

async function setStoredTabId(id) {
  await chrome.storage.session.set({ [OE_TAB_KEY]: id });
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete" && (t.url || "").startsWith(OE_BASE)) {
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
    tick();
  });
}

// Returns the id of a dedicated, logged-in OpenEvidence tab, creating a pinned
// background one if needed. Tracked by tab id (not URL), so it never collides
// with an OpenEvidence tab you opened yourself.
async function ensureOeTab() {
  const stored = await getStoredTabId();
  if (stored != null) {
    try {
      const t = await chrome.tabs.get(stored);
      if ((t.url || "").startsWith(OE_BASE)) return stored;
      // tab drifted off OpenEvidence — steer it back, then reuse.
      await chrome.tabs.update(stored, { url: `${OE_BASE}/` });
      await waitForTabComplete(stored);
      return stored;
    } catch (_e) {
      // tab was closed; fall through to create a fresh one.
    }
  }
  const created = await chrome.tabs.create({
    url: `${OE_BASE}/`,
    pinned: true,
    active: false,
  });
  await setStoredTabId(created.id);
  await waitForTabComplete(created.id);
  return created.id;
}

// ---- the in-tab POST ----------------------------------------------------------

// This function is serialized and run INSIDE the OpenEvidence tab.
function inTabAsk(body) {
  return fetch("/api/article", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  })
    .then((r) => r.text().then((text) => ({ status: r.status, text })))
    .catch((e) => ({ status: 0, text: "", error: String(e) }));
}

async function runAskInTab(body) {
  const tabId = await ensureOeTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inTabAsk,
    args: [body],
  });
  const out = injection && injection.result;
  if (!out) throw new Error("no result from in-tab fetch");
  if (out.error) throw new Error(out.error);
  if (out.status === 403) throw new Error("DataDome 403 even from the tab (re-auth in the browser)");
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`POST /api/article -> ${out.status} ${out.text.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(out.text);
  } catch (_e) {
    throw new Error("POST /api/article returned non-JSON");
  }
  const articleId = data && (data.id || data.article_id);
  if (!articleId) throw new Error("POST /api/article returned no id");
  return String(articleId);
}

// ---- relay loop ---------------------------------------------------------------

async function handleAsk(reqId, body) {
  try {
    const articleId = await runAskInTab(body);
    await postResult({ reqId, articleId });
  } catch (e) {
    await postResult({ reqId, error: String(e && e.message ? e.message : e) });
  }
}

async function postResult(payload) {
  try {
    await fetch(`${RELAY_BASE}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_e) {
    // server gone; nothing to do.
  }
}

async function pollOnce() {
  const res = await fetch(`${RELAY_BASE}/poll`, { method: "GET" });
  if (res.status === 200) {
    const { reqId, body } = await res.json();
    // handle without blocking the next poll
    handleAsk(reqId, body);
  } else {
    // 204 (timeout) or other — drain the body and loop.
    await res.text().catch(() => {});
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await pollOnce();
      } catch (_e) {
        // relay not up yet / transient — back off briefly, keep trying.
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onStartup.addListener(() => pollLoop());
chrome.runtime.onInstalled.addListener(() => pollLoop());
chrome.alarms.create("oe-relay-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oe-relay-keepalive") pollLoop();
});

// Kick immediately when the worker first loads.
pollLoop();
