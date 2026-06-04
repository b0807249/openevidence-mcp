// Live relay connection check for README.html. Talks to the local relay's
// /health endpoint (host permission for 127.0.0.1 is granted in the manifest).
// __RELAY_PORT__ is replaced with the real port at build time.
const PORT = "__RELAY_PORT__";
const HEALTH = `http://127.0.0.1:${PORT}/health`;

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const btnEl = document.getElementById("check");

function set(cls, text, detail) {
  statusEl.className = "badge " + cls;
  statusEl.innerHTML = '<span class="dot"></span>' + text;
  detailEl.textContent = detail || "";
}

async function check() {
  set("wait", "Checking relay…", "");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(HEALTH, { signal: ctrl.signal });
    clearTimeout(t);
    const h = await res.json();
    if (h && h.connected) {
      // version/pid only exist on the shared-daemon build; older relays omit them.
      const meta = h.version != null ? `relay v${h.version} · pid ${h.pid}` : "";
      set("ok", "Connected", meta);
    } else {
      set("bad", "Tab not logged in", "Relay is up, but no logged-in OpenEvidence tab is polling it.");
    }
  } catch {
    set("bad", "Relay not reachable", `No relay on 127.0.0.1:${PORT} — start your AI tool / MCP server.`);
  }
}

btnEl.addEventListener("click", check);
check();
