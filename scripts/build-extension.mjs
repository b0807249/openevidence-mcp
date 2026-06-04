// Build the Brave/Chrome extension from extension/ (TS source) into
// dist/extension/ (a loadable unpacked extension). The relay port is injected at
// build time so the extension matches the server's OE_MCP_RELAY_PORT.
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extDir = join(root, "extension");
const outDir = join(root, "dist", "extension");
const port = parseInt(process.env.OE_MCP_RELAY_PORT ?? "8787", 10);

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(extDir, "src", "background.ts")],
  outfile: join(outDir, "background.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  define: { __RELAY_PORT__: String(port) },
  legalComments: "none",
});

copyFileSync(join(extDir, "manifest.json"), join(outDir, "manifest.json"));

console.log(`built extension -> dist/extension (relay port ${port})`);
