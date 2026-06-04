import test from "node:test";
import assert from "node:assert/strict";

import { startRelayServer } from "../src/relay-server.js";

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("relay: delivers a request to a polling client and resolves with status+body", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    assert.equal(relay.isConnected(), false);

    const pollP = fetch(`http://127.0.0.1:${relay.port}/poll`).then((r) => r.json());
    const reqP = relay.request(
      { method: "POST", path: "/api/article", body: '{"q":1}' },
      { timeoutMs: 5000 },
    );

    const delivered = (await pollP) as {
      reqId: string;
      req: { method: string; path: string; body?: string };
    };
    assert.equal(delivered.req.method, "POST");
    assert.equal(delivered.req.path, "/api/article");
    assert.equal(delivered.req.body, '{"q":1}');
    assert.equal(relay.isConnected(), true);

    const r = await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      status: 200,
      body: '{"id":"abc-123"}',
    });
    assert.equal(r.status, 200);

    const out = await reqP;
    assert.equal(out.status, 200);
    assert.equal(out.body, '{"id":"abc-123"}');
  } finally {
    relay.close();
  }
});

test("relay: surfaces an extension-reported error", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const pollP = fetch(`http://127.0.0.1:${relay.port}/poll`).then((r) => r.json());
    const reqP = relay.request({ method: "GET", path: "/api/x" }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    const rejection = assert.rejects(reqP, /DataDome 403 even from the tab/);
    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      error: "DataDome 403 even from the tab",
    });
    await rejection;
  } finally {
    relay.close();
  }
});

test("relay: request times out when no extension responds", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    await assert.rejects(
      relay.request({ method: "GET", path: "/api/x" }, { timeoutMs: 150 }),
      /did not respond/,
    );
  } finally {
    relay.close();
  }
});

test("relay: /health reports connection state", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const h = await fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(h.connected, false);
  } finally {
    relay.close();
  }
});
