#!/usr/bin/env node
import "dotenv/config";

import { execFile, execFileSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";

import { ensureConfigDirs, resolveConfig } from "./config.js";
import { extractAnswerText, OpenEvidenceClient } from "./openevidence-client.js";

/**
 * Browser-driven ask: open the user's real, logged-in browser at
 * `/ask?query=...` so the `POST /api/article` originates from a genuine
 * browser context (real DataDome cookie + TLS + IP) and is not challenged,
 * then poll the read API (which is not DataDome-blocked) to recover the
 * resulting article. No headless browser, no fingerprint replay for the POST.
 *
 * Local-desktop only: relies on a GUI session with a default browser.
 */

export interface HistoryEntry {
  id: string;
  question?: string;
}

export interface BrowserAskOptions {
  question: string;
  configName?: string;
  /** Overall budget for the browser to produce a new article, in ms. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Open the tab without raising the browser to the foreground.
   * On macOS with a known `browserApp`, the tab is created via AppleScript with
   * no `activate`, so the browser truly stays in the background; otherwise it
   * falls back to `open -g`. The tab still loads and fires the ask.
   * Defaults to true. No-op on Linux/Windows (the URL opens normally).
   */
  background?: boolean;
  /**
   * macOS application name of the logged-in browser (e.g. "Brave Browser",
   * "Google Chrome", "Safari"). Enables the true-background AppleScript path.
   * Defaults to the system default browser.
   */
  browserApp?: string;
  /** Injectable opener (defaults to the OS `open`/`xdg-open`/`start`). */
  openUrl?: (url: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface BrowserAskResult {
  articleId: string;
  article: Record<string, unknown>;
  url: string;
}

/** Build the front-end ask URL, byte-for-byte matching the SPA's own format. */
export function buildAskUrl(baseUrl: string, question: string, configName = "prod"): string {
  const url = new URL("/ask", baseUrl);
  // URLSearchParams encodes spaces as "+" and "[]" as "%5B%5D" — exactly what
  // the captured HAR navigation uses (query=how+to+treat+anemia&attachments=%5B%5D).
  url.search = new URLSearchParams({
    query: question,
    configName,
    attachments: "[]",
  }).toString();
  return url.toString();
}

/** Normalize a question for loose equality against history entries. */
function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pick the article the browser just created: an entry not present before the
 * navigation. Prefer an exact question match; otherwise fall back to the first
 * new entry (history is newest-first).
 */
export function pickNewArticle(
  beforeIds: Set<string>,
  after: HistoryEntry[],
  question: string,
): HistoryEntry | undefined {
  const fresh = after.filter((entry) => entry.id && !beforeIds.has(entry.id));
  if (fresh.length === 0) return undefined;
  const target = normalizeQuestion(question);
  return fresh.find((entry) => normalizeQuestion(entry.question ?? "") === target) ?? fresh[0];
}

/** Flatten a /api/article/list payload into {id, question} entries. */
export function historyEntries(payload: unknown): HistoryEntry[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item): HistoryEntry[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; inputs?: { question?: unknown } };
    if (typeof record.id !== "string") return [];
    const question =
      typeof record.inputs?.question === "string" ? record.inputs.question : undefined;
    return [{ id: record.id, question }];
  });
}

const BUNDLE_TO_APP: Record<string, string> = {
  "com.brave.browser": "Brave Browser",
  "com.google.chrome": "Google Chrome",
  "com.google.chrome.canary": "Google Chrome Canary",
  "com.microsoft.edgemac": "Microsoft Edge",
  "com.apple.safari": "Safari",
  "org.mozilla.firefox": "Firefox",
  "company.thebrowser.browser": "Arc",
  "com.operasoftware.opera": "Opera",
  "com.vivaldi.vivaldi": "Vivaldi",
};

function isFirefox(app: string): boolean {
  return /firefox/i.test(app);
}

/**
 * AppleScript that drives a background ask WITHOUT activating the browser.
 *
 * Reuses an existing OpenEvidence tab when one is open — navigating a background
 * tab in place neither steals focus nor the active-tab slot, and avoids piling up
 * a new tab per ask. Only when no OE tab exists does it open a fresh one. The
 * persistent tab's URL stays on openevidence.com (it becomes /ask/<id> after the
 * answer), so it keeps being recognized and reused on the next ask.
 */
export function backgroundTabScript(browserApp: string, url: string): string[] {
  const safe = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Safari tracks an empty state via documents; the Chromium family via windows.
  const ensureWindow = /safari/i.test(browserApp)
    ? `    if (count of documents) is 0 then make new document`
    : `    if (count of windows) is 0 then make new window`;
  return [
    `tell application "${browserApp}"`,
    `  set didReuse to false`,
    `  repeat with w in windows`,
    `    repeat with t in tabs of w`,
    `      if (URL of t as string) contains "openevidence.com" then`,
    `        set URL of t to "${safe}"`,
    `        set didReuse to true`,
    `        exit repeat`,
    `      end if`,
    `    end repeat`,
    `    if didReuse then exit repeat`,
    `  end repeat`,
    `  if not didReuse then`,
    ensureWindow,
    `    tell front window to make new tab with properties {URL:"${safe}"}`,
    `  end if`,
    `end tell`,
  ];
}

/**
 * Build the OS command that opens a URL.
 * macOS + background + a known (non-Firefox) `browserApp` → AppleScript that
 * creates a tab without foregrounding the browser. Otherwise `open -g`.
 * Linux/Windows have no portable background flag, so the URL opens normally.
 */
export function openCommand(
  platform: string,
  url: string,
  options: { background?: boolean; browserApp?: string } = {},
): [string, string[]] {
  const background = options.background ?? true;
  if (platform === "darwin") {
    if (background && options.browserApp && !isFirefox(options.browserApp)) {
      return ["osascript", backgroundTabScript(options.browserApp, url).flatMap((l) => ["-e", l])];
    }
    return ["open", background ? ["-g", url] : [url]];
  }
  if (platform === "win32") {
    return ["cmd", ["/c", "start", "", url]];
  }
  return ["xdg-open", [url]];
}

/** Best-effort macOS default-browser app name (undefined elsewhere / on failure). */
export function detectMacDefaultBrowserApp(): string | undefined {
  if (osPlatform() !== "darwin") return undefined;
  try {
    const out = execFileSync(
      "defaults",
      ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
      { encoding: "utf8" },
    );
    // `defaults` prints keys alpha-sorted, so within each handler dict
    // LSHandlerRoleAll precedes LSHandlerURLScheme. Find the https handler block.
    for (const block of out.split("}")) {
      if (/LSHandlerURLScheme\s*=\s*https;/.test(block)) {
        const match = block.match(/LSHandlerRoleAll\s*=\s*"([^"]+)"/);
        if (match) return BUNDLE_TO_APP[match[1].toLowerCase()];
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function defaultOpenUrl(
  url: string,
  options: { background?: boolean; browserApp?: string } = {},
): Promise<void> {
  const [cmd, args] = openCommand(osPlatform(), url, options);
  return new Promise<void>((resolve, reject) => {
    execFile(cmd, args, (error) => {
      if (!error) {
        resolve();
        return;
      }
      // AppleScript tab creation can raise an AppleEvent timeout (-1712) on a
      // busy browser even though the tab does open. Rather than fail the whole
      // ask, degrade to the simple, reliable `open -g <url>` (default browser).
      if (cmd === "osascript" && osPlatform() === "darwin") {
        execFile("open", ["-g", url], (fallbackError) => {
          if (fallbackError) {
            reject(
              new Error(
                `Failed to open browser: osascript errored (${error.message}) and ` +
                  `\`open -g\` fallback also failed (${fallbackError.message}).`,
              ),
            );
            return;
          }
          resolve();
        });
        return;
      }
      reject(new Error(`Failed to open browser via \`${cmd}\`: ${error.message}`));
    });
  });
}

export async function askViaBrowser(
  client: Pick<OpenEvidenceClient, "listHistory" | "waitForArticle">,
  baseUrl: string,
  options: BrowserAskOptions,
): Promise<BrowserAskResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const background = options.background ?? true;
  const browserApp = options.browserApp;
  const openUrl =
    options.openUrl ?? ((url: string) => defaultOpenUrl(url, { background, browserApp }));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const progress = options.onProgress ?? (() => {});

  const beforeIds = new Set(historyEntries(await client.listHistory(20, 0)).map((e) => e.id));
  progress(`Snapshot: ${beforeIds.size} existing articles.`);

  const url = buildAskUrl(baseUrl, options.question, options.configName);
  await openUrl(url);
  progress(
    `Opened ${browserApp ?? "default browser"}${background ? " (background)" : ""} at ${url}`,
  );
  progress("Submit the ask in the browser if it does not auto-run, then leave the tab open.");

  // Exact question-match is authoritative: a concurrent/leftover ask can surface
  // a different "new" article first, so we only break on the matching question
  // and keep newest-new as a last-resort fallback after the timeout.
  const target = normalizeQuestion(options.question);
  const deadline = now() + timeoutMs;
  let exact: HistoryEntry | undefined;
  let fallback: HistoryEntry | undefined;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const fresh = historyEntries(await client.listHistory(10, 0)).filter(
      (entry) => entry.id && !beforeIds.has(entry.id),
    );
    if (fresh[0]) fallback = fresh[0];
    exact = fresh.find((entry) => normalizeQuestion(entry.question ?? "") === target);
    if (exact) break;
  }

  const found = exact ?? fallback;
  if (!found) {
    throw new Error(
      `No new article appeared within ${Math.round(timeoutMs / 1000)}s. ` +
        "Did the ask submit in the browser? (The `?query=` URL may prefill but not auto-run.)",
    );
  }
  progress(
    exact
      ? `New article detected: ${found.id}`
      : `No exact question match; falling back to newest new article ${found.id} (may be unrelated).`,
  );

  const remainingMs = Math.max(5_000, deadline - now());
  const article = await client.waitForArticle(found.id, {
    timeoutMs: remainingMs,
    intervalMs: pollIntervalMs,
  });
  return { articleId: found.id, article, url };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let foreground = false;
  let browserOverride: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--foreground") {
      foreground = true;
    } else if (arg === "--browser") {
      browserOverride = argv[(i += 1)];
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  const question = positional.join(" ").trim();
  if (!question) {
    throw new Error(
      'Usage: npm run ask:browser -- "your clinical question" [--foreground] [--browser "Safari"]',
    );
  }
  const browserApp =
    browserOverride || process.env.OE_MCP_BROWSER_APP || detectMacDefaultBrowserApp();

  const config = resolveConfig();
  ensureConfigDirs(config);
  const client = new OpenEvidenceClient(config);
  try {
    await client.init();
    const result = await askViaBrowser(client, config.baseUrl, {
      question,
      background: !foreground,
      browserApp,
      timeoutMs: config.pollTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      onProgress: (message) => stderr.write(`[ask:browser] ${message}\n`),
    });
    const answer = extractAnswerText(result.article);
    stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          article_id: result.articleId,
          status: result.article.status ?? null,
          answer_preview: answer ? `${answer.slice(0, 600)}${answer.length > 600 ? "…" : ""}` : null,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    stderr.write(`[ask:browser] failed: ${message}\n`);
    process.exit(1);
  });
}
