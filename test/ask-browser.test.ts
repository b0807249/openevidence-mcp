import test from "node:test";
import assert from "node:assert/strict";

import {
  askViaBrowser,
  backgroundTabScript,
  buildAskUrl,
  historyEntries,
  openCommand,
  pickNewArticle,
  type HistoryEntry,
} from "../src/ask-browser.js";

const BASE = "https://www.openevidence.com";

test("buildAskUrl matches the SPA navigation format (plus-encoded spaces, %5B%5D)", () => {
  const url = buildAskUrl(BASE, "how to treat anemia");
  assert.equal(
    url,
    "https://www.openevidence.com/ask?query=how+to+treat+anemia&configName=prod&attachments=%5B%5D",
  );
});

test("buildAskUrl honors a custom configName", () => {
  const url = buildAskUrl(BASE, "x", "staging");
  assert.match(url, /configName=staging/);
});

test("openCommand: macOS with a known browserApp uses AppleScript (no activate)", () => {
  const [cmd, args] = openCommand("darwin", "https://x/ask?q=1&a=2", {
    background: true,
    browserApp: "Brave Browser",
  });
  assert.equal(cmd, "osascript");
  const script = args.filter((a) => a !== "-e").join("\n");
  assert.match(script, /tell application "Brave Browser"/);
  assert.match(script, /make new tab with properties \{URL:"https:\/\/x\/ask\?q=1&a=2"\}/);
  assert.doesNotMatch(script, /activate/);
});

test("backgroundTabScript: reuses an existing OpenEvidence tab in place", () => {
  const script = backgroundTabScript(
    "Brave Browser",
    "https://www.openevidence.com/ask?query=x",
  ).join("\n");
  // Finds an OE tab and navigates it in place instead of always opening a new one.
  assert.match(script, /contains "openevidence\.com"/);
  assert.match(
    script,
    /set URL of t to "https:\/\/www\.openevidence\.com\/ask\?query=x"/,
  );
  // Still creates a tab only as the no-existing-tab fallback, and never activates.
  assert.match(script, /if not didReuse then/);
  assert.doesNotMatch(script, /activate/);
});

test("backgroundTabScript: Safari uses documents for the empty-window fallback", () => {
  const script = backgroundTabScript("Safari", "https://www.openevidence.com/ask").join("\n");
  assert.match(script, /if \(count of documents\) is 0 then make new document/);
});

test("openCommand: macOS background without browserApp falls back to `open -g`", () => {
  assert.deepEqual(openCommand("darwin", "https://x/ask", { background: true }), [
    "open",
    ["-g", "https://x/ask"],
  ]);
});

test("openCommand: macOS foreground uses bare `open`", () => {
  assert.deepEqual(openCommand("darwin", "https://x/ask", { background: false }), [
    "open",
    ["https://x/ask"],
  ]);
});

test("openCommand: Firefox is not AppleScript-driven (falls back to `open -g`)", () => {
  assert.deepEqual(openCommand("darwin", "https://x/ask", { background: true, browserApp: "Firefox" }), [
    "open",
    ["-g", "https://x/ask"],
  ]);
});

test("openCommand: linux/windows ignore background (no portable flag)", () => {
  assert.deepEqual(openCommand("linux", "https://x/ask", { background: true }), [
    "xdg-open",
    ["https://x/ask"],
  ]);
  assert.deepEqual(openCommand("win32", "https://x/ask", { background: true }), [
    "cmd",
    ["/c", "start", "", "https://x/ask"],
  ]);
});

test("historyEntries flattens /api/article/list results to {id, question}", () => {
  const entries = historyEntries({
    results: [
      { id: "a", inputs: { question: "Q1" } },
      { id: "b", inputs: {} },
      { nope: true },
      "garbage",
    ],
  });
  assert.deepEqual(entries, [
    { id: "a", question: "Q1" },
    { id: "b", question: undefined },
  ]);
});

test("pickNewArticle prefers exact question match among new entries", () => {
  const before = new Set(["old1", "old2"]);
  const after: HistoryEntry[] = [
    { id: "new-other", question: "unrelated" },
    { id: "new-match", question: "How to treat AML" },
    { id: "old1", question: "stale" },
  ];
  assert.equal(pickNewArticle(before, after, "how to treat aml")?.id, "new-match");
});

test("pickNewArticle falls back to the newest new entry when no question matches", () => {
  const before = new Set(["old1"]);
  const after: HistoryEntry[] = [
    { id: "new-top", question: "something" },
    { id: "old1", question: "stale" },
  ];
  assert.equal(pickNewArticle(before, after, "no match here")?.id, "new-top");
});

test("pickNewArticle returns undefined when nothing is new", () => {
  const before = new Set(["old1", "old2"]);
  const after: HistoryEntry[] = [{ id: "old1" }, { id: "old2" }];
  assert.equal(pickNewArticle(before, after, "q"), undefined);
});

test("askViaBrowser: opens URL, detects the new article, waits for it", async () => {
  const opened: string[] = [];
  let listCalls = 0;
  const fakeClient = {
    async listHistory() {
      listCalls += 1;
      // First call = pre-snapshot (only the old article).
      if (listCalls === 1) {
        return { results: [{ id: "old", inputs: { question: "prev" } }] };
      }
      // Second poll = the browser has created the new article.
      return {
        results: [
          { id: "fresh", inputs: { question: "How to treat AML" } },
          { id: "old", inputs: { question: "prev" } },
        ],
      };
    },
    async waitForArticle(id: string) {
      return { id, status: "success", answer: "done" };
    },
  };

  const result = await askViaBrowser(fakeClient, BASE, {
    question: "How to treat AML",
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    openUrl: async (url) => {
      opened.push(url);
    },
    sleep: async () => {},
  });

  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/ask\?query=How\+to\+treat\+AML/);
  assert.equal(result.articleId, "fresh");
  assert.equal(result.article.status, "success");
});

test("askViaBrowser: ignores a leftover new article and waits for the exact question match", async () => {
  let call = 0;
  const fakeClient = {
    async listHistory() {
      call += 1;
      if (call === 1) return { results: [{ id: "old", inputs: { question: "prev" } }] };
      // A leftover/concurrent ask shows up first — must NOT be picked.
      if (call === 2) {
        return {
          results: [
            { id: "leftover", inputs: { question: "some other question" } },
            { id: "old", inputs: { question: "prev" } },
          ],
        };
      }
      // Now the real answer to our question lands.
      return {
        results: [
          { id: "mine", inputs: { question: "How to treat AML" } },
          { id: "leftover", inputs: { question: "some other question" } },
          { id: "old", inputs: { question: "prev" } },
        ],
      };
    },
    async waitForArticle(id: string) {
      return { id, status: "success" };
    },
  };

  const result = await askViaBrowser(fakeClient, BASE, {
    question: "How to treat AML",
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    openUrl: async () => {},
    sleep: async () => {},
  });
  assert.equal(result.articleId, "mine", "must pick the exact-question match, not the leftover");
});

test("askViaBrowser: throws a helpful error when no new article appears", async () => {
  const fakeClient = {
    async listHistory() {
      return { results: [{ id: "old", inputs: { question: "prev" } }] };
    },
    async waitForArticle(id: string) {
      return { id };
    },
  };

  await assert.rejects(
    askViaBrowser(fakeClient, BASE, {
      question: "never submitted",
      timeoutMs: 5,
      pollIntervalMs: 1,
      openUrl: async () => {},
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    }),
    /No new article appeared/,
  );
});
