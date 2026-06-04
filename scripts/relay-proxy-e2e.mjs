// Integration test of the generic relay proxy against live OpenEvidence (reads).
// A fake "extension" polls the built relay and proxies each request via Node fetch
// (simulating the browser's in-tab fetch — faithful for GET reads, which are never
// DataDome-blocked). The client runs in relay mode with NO cookies of its own.
import { readFileSync } from "node:fs";
import { startRelayServer } from "../dist/relay-server.js";
import { resolveConfig, ensureConfigDirs } from "../dist/config.js";
import { OpenEvidenceClient } from "../dist/openevidence-client.js";

const BASE = "https://www.openevidence.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const cookies = JSON.parse(readFileSync(new URL("../cookies.json", import.meta.url)));
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = await startRelayServer({ port: 0, logger: (m) => console.log(`[relay] ${m}`) });

let running = true;
(async function fakeExtension() {
  while (running) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${relay.port}/poll`);
    } catch {
      await sleep(500);
      continue;
    }
    if (res.status !== 200) {
      await res.text().catch(() => "");
      continue;
    }
    const { reqId, req } = await res.json();
    let payload;
    try {
      const r = await fetch(BASE + req.path, {
        method: req.method,
        headers: {
          cookie: cookieHeader,
          "user-agent": UA,
          ...(req.body ? { "content-type": "application/json" } : {}),
        },
        body: req.body,
      });
      payload = { reqId, status: r.status, body: await r.text() };
    } catch (e) {
      payload = { reqId, error: String(e) };
    }
    await fetch(`http://127.0.0.1:${relay.port}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
})();

await sleep(400); // let the fake extension register a poll
console.log("relay connected:", relay.isConnected());

const config = resolveConfig();
ensureConfigDirs(config);
const client = new OpenEvidenceClient(config);
client.useRelay(relay); // client uses NO cookies of its own — pure relay transport
await client.init();

const auth = await client.getAuthStatus();
console.log("auth via relay:", auth.authenticated);

const hist = await client.listHistory(3, 0);
const results = hist?.results ?? [];
console.log("history via relay:", results.length, "entries; first id:", results[0]?.id ?? "(none)");

running = false;
client.close();
relay.close();
console.log("\n✅ generic proxy chain: client(no cookies) -> relay -> extension(sim) -> live OE GET");
