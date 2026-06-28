#!/usr/bin/env node
import "dotenv/config";

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform as osPlatform, arch as osArch } from "node:os";
import { stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";

import { ensureConfigDirs, resolveConfig, type AppConfig } from "./config.js";
import { DataDomeChallengeError, OpenEvidenceClient } from "./openevidence-client.js";
import { DEFAULT_BROWSER_FINGERPRINT, loadBrowserFingerprint, type BrowserFingerprint } from "./fingerprint.js";

const DATADOME_COOKIE_NAME = "datadome";
const OE_DOMAIN = "openevidence.com";
/** DataDome re-challenges roughly when the token nears expiry; warn ahead of time. */
const EXPIRY_WARN_DAYS = 14;

export type CheckLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
  level: CheckLevel;
  code: string;
  message: string;
  hint?: string;
}

export interface HostSignature {
  /** Node `os.platform()` value, e.g. "darwin" | "linux" | "win32". */
  platform: string;
  /** Node `os.arch()` value, e.g. "arm64" | "x64". */
  arch: string;
}

export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  /** Expiry in epoch seconds, or null for a session cookie. */
  expires: number | null;
}

export interface StaticAnalysisInput {
  cookies: RawCookie[];
  fingerprint: BrowserFingerprint;
  /** True when no fingerprint file was found and the built-in default is in use. */
  fingerprintIsDefault: boolean;
  host: HostSignature;
  nowMs: number;
}

/**
 * Pure, network-free analysis of whether the `datadome` cookie is likely stale.
 *
 * Two failure modes are covered:
 *  1. The cookie is missing / empty / expired.
 *  2. The cookie + fingerprint were minted on a *different machine* than the one
 *     running now. DataDome binds its token to the (UA + client-hints + IP + TLS)
 *     signature at mint time, so a fingerprint that advertises a different OS/arch
 *     than the host means the token will be re-challenged here.
 */
export function analyzeDatadomeStatic(input: StaticAnalysisInput): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const cookie = findDatadomeCookie(input.cookies);

  if (!cookie) {
    checks.push({
      level: "fail",
      code: "datadome-missing",
      message: `No \`${DATADOME_COOKIE_NAME}\` cookie for ${OE_DOMAIN} in the cookie jar.`,
      hint: "Log into www.openevidence.com in a real browser, run one Ask, then re-export cookies.json.",
    });
  } else if (cookie.value.trim().length === 0) {
    checks.push({
      level: "fail",
      code: "datadome-empty",
      message: `The \`${DATADOME_COOKIE_NAME}\` cookie is present but has an empty value.`,
      hint: "Re-export cookies.json from a logged-in browser session.",
    });
  } else {
    checks.push({
      level: "pass",
      code: "datadome-present",
      message: `\`${DATADOME_COOKIE_NAME}\` cookie present for .${cookie.domain} (${cookie.value.length} chars).`,
    });
    checks.push(expiryCheck(cookie, input.nowMs));
  }

  checks.push(...fingerprintMatchChecks(input));
  return checks;
}

function expiryCheck(cookie: RawCookie, nowMs: number): DoctorCheck {
  if (cookie.expires === null) {
    return {
      level: "warn",
      code: "datadome-session",
      message: `\`${DATADOME_COOKIE_NAME}\` is a session cookie (no expiry) — it may already be dead.`,
      hint: "Session-scoped DataDome tokens do not survive a browser restart. Re-export if requests 403.",
    };
  }

  const nowSec = nowMs / 1000;
  if (cookie.expires <= nowSec) {
    return {
      level: "fail",
      code: "datadome-expired",
      message: `\`${DATADOME_COOKIE_NAME}\` expired on ${formatEpoch(cookie.expires)}.`,
      hint: "Re-authenticate in a browser and re-export cookies.json.",
    };
  }

  const daysLeft = Math.floor((cookie.expires - nowSec) / 86_400);
  if (daysLeft <= EXPIRY_WARN_DAYS) {
    return {
      level: "warn",
      code: "datadome-expiring",
      message: `\`${DATADOME_COOKIE_NAME}\` expires in ${daysLeft}d (${formatEpoch(cookie.expires)}).`,
      hint: "Refresh cookies.json soon to avoid a surprise DataDome challenge.",
    };
  }

  return {
    level: "pass",
    code: "datadome-not-expired",
    message: `\`${DATADOME_COOKIE_NAME}\` valid for ${daysLeft}d (expires ${formatEpoch(cookie.expires)}).`,
  };
}

function fingerprintMatchChecks(input: StaticAnalysisInput): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  if (input.fingerprintIsDefault) {
    checks.push({
      level: "warn",
      code: "fingerprint-default",
      message: "No openevidence-fingerprint.json found — using the built-in macOS/arm signature.",
      hint: "On this machine, export a HAR of a successful ask and run `make build HAR=/path/to.har`.",
    });
  }

  const fpPlatform = fingerprintPlatform(input.fingerprint);
  const hostFamily = hostPlatformFamily(input.host.platform);

  if (fpPlatform && hostFamily && fpPlatform !== hostFamily) {
    checks.push({
      level: "fail",
      code: "fingerprint-platform-mismatch",
      message: `Fingerprint OS "${fpPlatform}" does not match this host "${hostFamily}" (${input.host.platform}).`,
      hint:
        "The datadome cookie + fingerprint were minted on a different machine. DataDome will re-challenge here. " +
        "Re-mint on THIS machine: browser login, export cookies.json + HAR, `make build HAR=...`.",
    });
    return checks;
  }

  const fpArch = fingerprintArch(input.fingerprint);
  const hostArchFamily = hostArchFamily_(input.host.arch);
  if (fpPlatform && hostFamily && fpArch && hostArchFamily && fpArch !== hostArchFamily) {
    checks.push({
      level: "warn",
      code: "fingerprint-arch-mismatch",
      message: `Fingerprint CPU "${fpArch}" differs from this host "${hostArchFamily}" (${input.host.arch}).`,
      hint: "Same OS but different CPU class — DataDome may re-score. Re-mint the fingerprint if requests 403.",
    });
    return checks;
  }

  if (fpPlatform && hostFamily) {
    checks.push({
      level: "pass",
      code: "fingerprint-host-match",
      message: `Fingerprint signature (${fpPlatform}/${fpArch ?? "?"}) matches this host.`,
    });
  }

  return checks;
}

function findDatadomeCookie(cookies: RawCookie[]): RawCookie | undefined {
  return cookies.find(
    (c) =>
      c.name.toLowerCase() === DATADOME_COOKIE_NAME &&
      (c.domain === OE_DOMAIN || c.domain.endsWith(`.${OE_DOMAIN}`) || c.domain === ""),
  );
}

function headerValue(fingerprint: BrowserFingerprint, name: string): string | undefined {
  const match = fingerprint.headers.find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

/** Map the fingerprint's `sec-ch-ua-platform` (or UA) to a coarse OS family. */
function fingerprintPlatform(fingerprint: BrowserFingerprint): string | undefined {
  const raw = headerValue(fingerprint, "sec-ch-ua-platform");
  const fromHint = normalizePlatformLabel(raw?.replace(/"/g, ""));
  if (fromHint) return fromHint;
  return platformFromUserAgent(headerValue(fingerprint, "user-agent"));
}

function normalizePlatformLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const v = label.toLowerCase();
  if (v.includes("mac")) return "macos";
  if (v.includes("win")) return "windows";
  if (v.includes("android")) return "android";
  if (v.includes("chrome os") || v.includes("chromeos")) return "linux";
  if (v.includes("linux")) return "linux";
  return undefined;
}

function platformFromUserAgent(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const v = ua.toLowerCase();
  if (v.includes("macintosh") || v.includes("mac os")) return "macos";
  if (v.includes("windows")) return "windows";
  if (v.includes("android")) return "android";
  if (v.includes("x11") || v.includes("linux")) return "linux";
  return undefined;
}

function hostPlatformFamily(platform: string): string | undefined {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "android":
      return "android";
    default:
      return undefined;
  }
}

/** Map `sec-ch-ua-arch` (e.g. "arm", "x86") to a coarse family. */
function fingerprintArch(fingerprint: BrowserFingerprint): string | undefined {
  const raw = headerValue(fingerprint, "sec-ch-ua-arch")?.replace(/"/g, "").toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("arm")) return "arm";
  if (raw.includes("x86") || raw.includes("x64") || raw.includes("amd64")) return "x86";
  return undefined;
}

function hostArchFamily_(arch: string): string | undefined {
  if (arch.startsWith("arm")) return "arm";
  if (arch === "x64" || arch === "ia32" || arch === "x86") return "x86";
  return undefined;
}

function formatEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Parse a browser-exported cookies array or storage-state object into raw cookies. */
export function parseRawCookies(parsed: unknown): RawCookie[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? ((parsed as { cookies: unknown[] }).cookies)
      : null;

  if (!list) {
    throw new Error(
      "Unsupported cookie file. Expected a cookies array or a storage-state object with a cookies array.",
    );
  }

  const out: RawCookie[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.length === 0) continue;
    const domain = typeof c.domain === "string" ? c.domain.replace(/^\./, "").toLowerCase() : "";
    out.push({
      name: c.name,
      value: c.value === undefined || c.value === null ? "" : String(c.value),
      domain,
      expires: rawExpires(c),
    });
  }
  return out;
}

function rawExpires(c: Record<string, unknown>): number | null {
  const value =
    typeof c.expirationDate === "number"
      ? c.expirationDate
      : typeof c.expires === "number"
        ? c.expires
        : null;
  if (value === null || value <= 0) return null;
  return value;
}

export function summarize(checks: DoctorCheck[]): {
  pass: number;
  warn: number;
  fail: number;
  ok: boolean;
} {
  const pass = checks.filter((c) => c.level === "pass").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  const fail = checks.filter((c) => c.level === "fail").length;
  return { pass, warn, fail, ok: fail === 0 };
}

const ICONS: Record<CheckLevel, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

function renderText(header: Record<string, string>, checks: DoctorCheck[]): string {
  const lines: string[] = ["openevidence-mcp doctor", ""];
  for (const [key, value] of Object.entries(header)) {
    lines.push(`  ${key.padEnd(14)}${value}`);
  }
  lines.push("");
  for (const check of checks) {
    lines.push(`  [${ICONS[check.level]}] ${check.message}`);
    if (check.hint) {
      lines.push(`         -> ${check.hint}`);
    }
  }
  const s = summarize(checks);
  lines.push("");
  lines.push(`  Summary: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail.`);
  return `${lines.join("\n")}\n`;
}

async function runLiveProbe(config: AppConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const client = new OpenEvidenceClient(config);
  try {
    await client.init();
    const auth = await client.getAuthStatus();
    if (!auth.authenticated) {
      checks.push({
        level: "fail",
        code: "auth",
        message: `Login session is not active (status ${auth.statusCode}).`,
        hint: "Run `npm run login` after refreshing cookies.json.",
      });
      return checks;
    }
    checks.push({ level: "pass", code: "auth", message: "Login session active (/api/auth/me 200)." });

    try {
      await client.listHistory(1, 0);
      checks.push({
        level: "pass",
        code: "datadome-live",
        message: "Live read passed the DataDome layer (GET /api/article/list 200).",
      });
    } catch (error) {
      if (error instanceof DataDomeChallengeError) {
        checks.push({
          level: "fail",
          code: "datadome-live",
          message: "DataDome challenged a live request (403) — the cookie is stale for this machine.",
          hint: "Re-mint on THIS machine: browser login, export cookies.json + HAR, `make build HAR=...`.",
        });
      } else {
        checks.push({
          level: "warn",
          code: "live-probe-error",
          message: `Live probe could not complete: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    client.close();
  }
  return checks;
}

/**
 * Audit running relay daemons. Exactly one should exist; extras are orphans that
 * accumulate without garbage collection (sleep/wake, port drift, respawns). The
 * daemon now self-reaps, but this surfaces any survivors so `make reap` can clear
 * them. Best-effort and POSIX-only (pgrep); silently skips where unavailable.
 */
function relayDaemonChecks(): DoctorCheck[] {
  let pids: number[] = [];
  try {
    const out = execFileSync("pgrep", ["-f", "dist/relay-daemon.js"], {
      encoding: "utf8",
    });
    pids = out
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n));
  } catch {
    // pgrep exits 1 when nothing matches (or is missing) — treat as zero daemons.
    return [
      {
        level: "pass",
        code: "relay-daemons",
        message: "no relay daemon running (a session will spawn one on demand)",
      },
    ];
  }
  if (pids.length <= 1) {
    return [
      {
        level: "pass",
        code: "relay-daemons",
        message: `${pids.length} relay daemon running${pids.length ? ` (pid ${pids[0]})` : ""}`,
      },
    ];
  }
  return [
    {
      level: "warn",
      code: "relay-daemons",
      message: `${pids.length} relay daemons running (pids ${pids.join(", ")}) — only one is needed`,
      hint: "Orphaned daemons self-reap within the idle TTL; run `make reap` to clear them now.",
    },
  ];
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const asJson = process.argv.includes("--json");
  const config = resolveConfig();
  ensureConfigDirs(config);

  const raw = await readFile(config.cookiesPath, "utf8").catch((error: unknown) => {
    throw new Error(
      `Cannot read cookies at ${config.cookiesPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const cookies = parseRawCookies(JSON.parse(raw) as unknown);
  const fingerprint = await loadBrowserFingerprint(config.fingerprintPath);
  const host: HostSignature = { platform: osPlatform(), arch: osArch() };

  const checks: DoctorCheck[] = analyzeDatadomeStatic({
    cookies,
    fingerprint,
    fingerprintIsDefault: !config.fingerprintPath || fingerprint === DEFAULT_BROWSER_FINGERPRINT,
    host,
    nowMs: Date.now(),
  });

  checks.push(...relayDaemonChecks());

  if (!offline) {
    checks.push(...(await runLiveProbe(config)));
  }

  const header: Record<string, string> = {
    cookies: config.cookiesPath,
    fingerprint: config.fingerprintPath ?? "(built-in default)",
    host: `${host.platform} / ${host.arch}`,
    mode: offline ? "offline (static only)" : "online (static + live probe)",
  };

  if (asJson) {
    stdout.write(`${JSON.stringify({ header, checks, summary: summarize(checks) }, null, 2)}\n`);
  } else {
    stdout.write(renderText(header, checks));
  }

  process.exit(summarize(checks).ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    stderr.write(`[doctor] failed: ${message}\n`);
    process.exit(1);
  });
}
