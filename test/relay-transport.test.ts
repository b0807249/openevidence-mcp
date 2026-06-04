import test from "node:test";
import assert from "node:assert/strict";

import type { AppConfig } from "../src/config.js";
import { OpenEvidenceClient, type RelayTransport } from "../src/openevidence-client.js";
import { DEFAULT_RATE_LIMIT_CONFIG } from "../src/rate-limit.js";

function relayConfig(): AppConfig {
  return {
    baseUrl: "https://www.openevidence.com",
    cookiesPath: "/nonexistent/cookies.json", // must NOT be touched in relay mode
    fingerprintPath: undefined,
    artifactDir: "/tmp",
    crossrefValidate: false,
    pollIntervalMs: 10,
    pollTimeoutMs: 1000,
    browserFallback: true,
    relayEnabled: true,
    relayPort: 8787,
    relayTransport: "all",
    rateLimit: DEFAULT_RATE_LIMIT_CONFIG,
  };
}

test("client routes through the relay (no cookies) when one is connected", async () => {
  const calls: { method: string; path: string; body?: string }[] = [];
  const transport: RelayTransport = {
    isConnected: () => true,
    request: async (req) => {
      calls.push(req);
      if (req.path === "/api/auth/me") {
        return { status: 200, body: JSON.stringify({ user: "me" }) };
      }
      if (req.path.startsWith("/api/article/list")) {
        return { status: 200, body: JSON.stringify({ results: [{ id: "a1" }] }) };
      }
      return { status: 200, body: "{}" };
    },
  };

  const client = new OpenEvidenceClient(relayConfig());
  client.useRelay(transport);
  await client.init(); // must succeed without reading the (nonexistent) cookie file

  const auth = await client.getAuthStatus();
  assert.equal(auth.authenticated, true);

  const hist = (await client.listHistory(5, 0)) as { results: { id: string }[] };
  assert.deepEqual(hist.results, [{ id: "a1" }]);

  assert.ok(calls.some((c) => c.method === "GET" && c.path === "/api/auth/me"));
  assert.ok(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/article/list")));
});

test("client POSTs the ask body through the relay verbatim", async () => {
  let seen: { method: string; path: string; body?: string } | undefined;
  const transport: RelayTransport = {
    isConnected: () => true,
    request: async (req) => {
      if (req.path === "/api/article" && req.method === "POST") {
        seen = req;
        return { status: 200, body: JSON.stringify({ id: "new-1" }) };
      }
      return { status: 200, body: "{}" };
    },
  };
  const client = new OpenEvidenceClient(relayConfig());
  client.useRelay(transport);
  await client.init();

  const created = await client.ask({ question: "what is sepsis" });
  assert.equal(created.id, "new-1");
  assert.ok(seen, "ask POST went through the relay");
  const body = JSON.parse(seen!.body ?? "{}") as { inputs?: { question?: string } };
  assert.equal(body.inputs?.question, "what is sepsis");
});
