// Prove `open <askUrl>` creates an article end-to-end: snapshot history,
// open the real browser in background, poll history until the new article appears.
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";

const BASE = "https://www.openevidence.com";
const cookies = JSON.parse(readFileSync(new URL("../cookies.json", import.meta.url)));
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();

async function history() {
  const res = await fetch(`${BASE}/api/article/list?limit=10&offset=0`, {
    headers: { accept: "application/json", cookie: cookieHeader, "user-agent": UA },
  });
  const data = await res.json();
  return (data.results ?? []).map((r) => ({ id: r.id, q: r.inputs?.question ?? "" }));
}

const question = `relay test ${process.argv[2] ?? ""} what is first-line treatment for DLBCL`.trim();
const askUrl =
  `${BASE}/ask?` +
  new URLSearchParams({ query: question, configName: "prod", attachments: "[]" }).toString();

const before = await history();
const beforeIds = new Set(before.map((e) => e.id));
console.log(`[probe] before: ${before.length} articles`);
console.log(`[probe] opening (background): ${askUrl}`);

await new Promise((res, rej) =>
  execFile("open", ["-g", askUrl], (e) => (e ? rej(e) : res())),
);

const target = norm(question);
const deadline = Date.now() + 90_000;
let found;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const fresh = (await history()).filter((e) => e.id && !beforeIds.has(e.id));
  const exact = fresh.find((e) => norm(e.q) === target);
  if (exact) { found = exact; break; }
  if (fresh.length) console.log(`[probe] new (non-matching) entries: ${fresh.map((f) => f.id).join(", ")}`);
  process.stdout.write(".");
}
console.log();

if (!found) {
  console.log("[probe] NO matching article within 90s. Did the tab auto-fire? (may only prefill)");
  process.exit(2);
}
console.log(`[probe] ✅ article created: ${found.id}`);
console.log(`[probe] url: ${BASE}/ask/${found.id}`);

// fetch its status
const art = await (
  await fetch(`${BASE}/api/article/${found.id}`, {
    headers: { accept: "application/json", cookie: cookieHeader, "user-agent": UA },
  })
).json();
console.log(`[probe] status: ${art.status ?? "(none)"}`);
