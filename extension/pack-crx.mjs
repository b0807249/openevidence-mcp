// Pack the built extension (extension/dist/) into a signed .crx.
// Key: CRX_KEY env (a .pem path, e.g. from a CI secret) or extension/key.pem.
// crx3 generates the key if it does not exist (keep key.pem safe — it fixes the
// extension's identity across versions; it is gitignored, never commit it).
import crx3 from "crx3";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "dist");
const keyPath = process.env.CRX_KEY || join(here, "key.pem");
const crxPath = join(distDir, "openevidence-mcp-relay-extension.crx");

if (!existsSync(join(distDir, "manifest.json"))) {
  throw new Error("extension/dist not built — run `npm run build` first");
}

// manifest.json must be first; exclude prior build artifacts.
const files = readdirSync(distDir)
  .filter((f) => !f.endsWith(".crx") && !f.endsWith(".zip"))
  .sort((a, b) => (a === "manifest.json" ? -1 : b === "manifest.json" ? 1 : 0))
  .map((f) => join(distDir, f));

await crx3(files, { keyPath, crxPath });
console.log(`packed ${crxPath}\n  signed with ${keyPath}`);
