import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "./config.js";

const PYTHON = process.env.OE_MCP_PYTHON ?? "python3";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "collection_sort.py");
const CLASSIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "classify.py");

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  rateSeconds?: number;
  retries?: number;
  verbose?: boolean;
}

export async function runCollectionSort(
  config: AppConfig,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const baseArgs: string[] = [SCRIPT, "--cookies", config.cookiesPath];
  if (opts.rateSeconds !== undefined) baseArgs.push("--rate", String(opts.rateSeconds));
  if (opts.retries !== undefined) baseArgs.push("--retries", String(opts.retries));
  if (opts.verbose) baseArgs.push("--verbose");
  return spawnPython([...baseArgs, ...args]);
}

export async function runClassify(args: string[]): Promise<RunResult> {
  return spawnPython([CLASSIFY_SCRIPT, ...args]);
}

function spawnPython(fullArgs: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, fullArgs, { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.stdin.end();
  });
}

export function parseStdoutJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!m) throw new Error(`no JSON in stdout: ${trimmed.slice(0, 200)}`);
    return JSON.parse(m[1]);
  }
}

export async function withTempPlan<T>(
  plan: unknown,
  descriptions: unknown,
  fn: (paths: { planPath: string; descriptionsPath?: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "oe-bulk-"));
  const planPath = path.join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(plan), "utf8");
  let descriptionsPath: string | undefined;
  if (descriptions !== undefined) {
    descriptionsPath = path.join(dir, "descriptions.json");
    await writeFile(descriptionsPath, JSON.stringify(descriptions), "utf8");
  }
  return fn({ planPath, descriptionsPath });
}
