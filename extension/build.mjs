// Build this extension (TS source -> dist/) as a self-contained sub-project.
// The relay port is injected at build time so it matches the MCP server's
// OE_MCP_RELAY_PORT (default 8787); set that env var before building if changed.
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "dist");
const port = parseInt(process.env.OE_MCP_RELAY_PORT ?? "8787", 10);

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(here, "src", "background.ts")],
  outfile: join(outDir, "background.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  define: { __RELAY_PORT__: String(port) },
  legalComments: "none",
});

copyFileSync(join(here, "manifest.json"), join(outDir, "manifest.json"));

console.log(`built openevidence-mcp-relay-extension -> extension/dist (relay port ${port})`);
