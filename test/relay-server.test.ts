import test from "node:test";
import assert from "node:assert/strict";

import { startRelayServer } from "../src/relay-server.js";

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("relay: delivers an ask to a polling client and resolves with the article id", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    assert.equal(relay.isConnected(), false);

    const pollP = fetch(`http://127.0.0.1:${relay.port}/poll`).then((r) => r.json());
    const submitP = relay.submitAsk({ inputs: { question: "x" } }, { timeoutMs: 5000 });

    const delivered = (await pollP) as { reqId: string; body: unknown };
    assert.deepEqual(delivered.body, { inputs: { question: "x" } });
    assert.equal(relay.isConnected(), true);

    const r = await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      articleId: "abc-123",
    });
    assert.equal(r.status, 200);

    const out = await submitP;
    assert.equal(out.articleId, "abc-123");
  } finally {
    relay.close();
  }
});

test("relay: surfaces an extension-reported error", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const pollP = fetch(`http://127.0.0.1:${relay.port}/poll`).then((r) => r.json());
    const submitP = relay.submitAsk({ q: 1 }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    // Attach the rejection expectation BEFORE triggering it, so the rejection is
    // never momentarily unhandled.
    const rejection = assert.rejects(submitP, /DataDome 403 even from the tab/);
    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      error: "DataDome 403 even from the tab",
    });
    await rejection;
  } finally {
    relay.close();
  }
});

test("relay: submitAsk times out when no extension responds", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    await assert.rejects(
      relay.submitAsk({ q: 1 }, { timeoutMs: 150 }),
      /did not return an article/,
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
