// End-to-end proof of the integrated auto-fallback, against built dist/.
// Mirrors the oe_ask handler: Node POST -> DataDome -> askViaBrowser -> answer.
import { resolveConfig, ensureConfigDirs } from "../dist/config.js";
import {
  OpenEvidenceClient,
  extractAnswerText,
  DataDomeChallengeError,
} from "../dist/openevidence-client.js";
import { askViaBrowser, detectMacDefaultBrowserApp } from "../dist/ask-browser.js";

const config = resolveConfig();
ensureConfigDirs(config);
const client = new OpenEvidenceClient(config);
await client.init();

const question = `relay e2e ${process.argv[2] ?? ""} what is the first-line treatment for ENKTL`.trim();
const timeoutMs = 120_000;
const intervalMs = config.pollIntervalMs;
let articleId = "";
let article = {};
let path = "node-post";

const force = process.argv.includes("force");
try {
  if (force) {
    console.log("[e2e] FORCING DataDome challenge to exercise the fallback branch ...");
    throw new DataDomeChallengeError("POST /api/article", new Headers());
  }
  console.log("[e2e] trying Node POST /api/article ...");
  const created = await client.ask({ question, variantConfigurationFile: "prod" });
  articleId = String(created.id ?? "");
  article = await client.waitForArticle(articleId, { timeoutMs, intervalMs });
} catch (error) {
  if (error instanceof DataDomeChallengeError && config.browserFallback) {
    path = "browser-fallback";
    console.log(`[e2e] DataDome blocked the POST -> browser fallback. (${error.message})`);
    const r = await askViaBrowser(client, config.baseUrl, {
      question,
      background: true,
      browserApp: detectMacDefaultBrowserApp(),
      timeoutMs,
      pollIntervalMs: intervalMs,
      onProgress: (m) => console.log(`  [via_browser] ${m}`),
    });
    articleId = r.articleId;
    article = r.article;
  } else {
    client.close();
    throw error;
  }
}

const answer = extractAnswerText(article);
console.log("\n========== RESULT ==========");
console.log("path:        ", path);
console.log("article_id:  ", articleId);
console.log("url:         ", `${config.baseUrl}/ask/${articleId}`);
console.log("status:      ", article.status ?? "(none)");
console.log("answer chars:", answer ? answer.length : 0);
console.log("answer head: ", answer ? answer.slice(0, 500) : "(none)");
client.close();
