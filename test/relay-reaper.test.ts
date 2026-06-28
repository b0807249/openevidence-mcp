import test from "node:test";
import assert from "node:assert/strict";

import { evaluateReap, type ReapInputs } from "../src/relay-reaper.js";

const base: ReapInputs = {
  connected: false,
  pending: 0,
  now: 1_000_000,
  idleSince: null,
  idleTtlMs: 600_000,
  pidfilePid: 42, // our own pid by default
  pidfileAlive: false,
  myPid: 42,
};

test("reaper: a busy daemon (extension connected) is never reaped and idle resets", () => {
  const d = evaluateReap({ ...base, connected: true, idleSince: 5 });
  assert.equal(d.reap, false);
  assert.equal(d.idleSince, null);
});

test("reaper: pending requests keep an otherwise-disconnected daemon alive", () => {
  const d = evaluateReap({ ...base, connected: false, pending: 3, idleSince: 5 });
  assert.equal(d.reap, false);
  assert.equal(d.idleSince, null);
});

test("reaper: first idle tick records the timestamp without reaping", () => {
  const d = evaluateReap({ ...base, idleSince: null, now: 1_000_000 });
  assert.equal(d.reap, false);
  assert.equal(d.idleSince, 1_000_000);
});

test("reaper: reaps once idle exceeds the TTL", () => {
  const d = evaluateReap({ ...base, idleSince: 1_000_000, now: 1_000_000 + 600_000 });
  assert.equal(d.reap, true);
  assert.equal(d.reason, "idle");
});

test("reaper: idle TTL of 0 disables idle reaping (outlive forever)", () => {
  const d = evaluateReap({ ...base, idleTtlMs: 0, idleSince: 1, now: 9_999_999_999 });
  assert.equal(d.reap, false);
});

test("reaper: reaps when the pidfile names a different, live daemon (superseded)", () => {
  const d = evaluateReap({ ...base, pidfilePid: 99, pidfileAlive: true });
  assert.equal(d.reap, true);
  assert.equal(d.reason, "superseded");
});

test("reaper: a different pid that is NOT alive does not trigger supersede", () => {
  const d = evaluateReap({ ...base, pidfilePid: 99, pidfileAlive: false, connected: true });
  assert.equal(d.reap, false);
});

test("reaper: supersede takes priority over idle bookkeeping", () => {
  const d = evaluateReap({
    ...base,
    pidfilePid: 99,
    pidfileAlive: true,
    idleSince: 1_000_000,
    now: 1_000_000 + 600_000,
  });
  assert.equal(d.reap, true);
  assert.equal(d.reason, "superseded");
});

test("reaper: a missing pidfile (null pid) never supersedes", () => {
  const d = evaluateReap({ ...base, pidfilePid: null, pidfileAlive: true, connected: true });
  assert.equal(d.reap, false);
});
