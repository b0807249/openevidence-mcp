#!/usr/bin/env node
import "dotenv/config";

import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { askViaBrowser, detectMacDefaultBrowserApp } from "./ask-browser.js";
import { startRelayServer, type RelayServer } from "./relay-server.js";
import { extractFigures, saveArticleArtifacts } from "./citations.js";
import { ensureConfigDirs, resolveConfig } from "./config.js";
import {
	DataDomeChallengeError,
	buildAskBody,
	extractAnswerText,
	OpenEvidenceClient,
	resolveVisualTags,
} from "./openevidence-client.js";
import {
	parseStdoutJson,
	runClassify,
	runCollectionSort,
	withTempPlan,
} from "./python-bridge.js";
import type { OpenEvidenceAskRequest } from "./types.js";

const config = resolveConfig();
ensureConfigDirs(config);

let relayServerPromise: Promise<RelayServer | null> | null = null;
function getRelay(): Promise<RelayServer | null> {
	if (!config.relayEnabled) return Promise.resolve(null);
	if (!relayServerPromise) {
		relayServerPromise = startRelayServer({
			port: config.relayPort,
			logger: (m) => process.stderr.write(`[relay] ${m}\n`),
		}).catch((err) => {
			process.stderr.write(`[relay] failed to start: ${String(err)}\n`);
			return null;
		});
	}
	return relayServerPromise;
}

// Start the relay eagerly so the extension can connect as soon as the server is up.
void getRelay();

const server = new McpServer({
	name: "openevidence-mcp",
	version: "1.0.0",
});

server.registerTool(
	"oe_auth_status",
	{
		title: "OpenEvidence Auth Status",
		description: "Check if the local OpenEvidence session is valid.",
	},
	async () =>
		withClient(async (client) => {
			const status = await client.getAuthStatus();
			return ok(status);
		}),
);

server.registerTool(
	"oe_history_list",
	{
		title: "OpenEvidence History List",
		description: "List question history from OpenEvidence account.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(100).default(20).optional(),
			offset: z.number().int().min(0).default(0).optional(),
			search: z.string().max(200).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.listHistory(
				args.limit ?? 20,
				args.offset ?? 0,
				args.search,
			);
			return ok(data);
		}),
);

server.registerTool(
	"oe_article_get",
	{
		title: "OpenEvidence Article Get",
		description: "Fetch article payload by article id.",
		inputSchema: z.object({
			article_id: z.string().uuid(),
			save_artifacts: z.boolean().default(true).optional(),
			crossref_validate: z.boolean().default(true).optional(),
			include_bibtex: z.boolean().default(true).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const article = await client.getArticle(args.article_id);
			const figures = extractFigures(article);
			const answerRaw = extractAnswerText(article);
			const artifacts =
				(args.save_artifacts ?? true)
					? await saveArticleArtifacts(article, config, {
							validateWithCrossref:
								args.crossref_validate ?? config.crossrefValidate,
						})
					: null;
			return ok({
				article_id: args.article_id,
				extracted_answer_raw: answerRaw
					? resolveVisualTags(answerRaw, figures)
					: null,
				figures,
				artifacts: formatArtifactsForResponse(
					artifacts,
					args.include_bibtex ?? true,
				),
			});
		}),
);

server.registerTool(
	"oe_ask",
	{
		title: "OpenEvidence Ask",
		description:
			"Create a question and optionally wait for completion. For follow-up question pass original_article_id. " +
			"If the Node POST is DataDome-blocked it automatically falls back to your real logged-in browser (disable via OE_MCP_BROWSER_FALLBACK=0); set via_browser=true to force the browser path; " +
			"the id is then recovered by diffing history.",
		inputSchema: z.object({
			question: z.string().min(3).max(6000),
			original_article_id: z.string().uuid().optional(),
			via_browser: z.boolean().default(false).optional(),
			via_browser_background: z.boolean().default(true).optional(),
			via_browser_app: z.string().optional(),
			wait_for_completion: z.boolean().default(true).optional(),
			timeout_sec: z.number().int().min(5).max(600).default(120).optional(),
			poll_interval_ms: z
				.number()
				.int()
				.min(300)
				.max(10000)
				.default(1200)
				.optional(),
			disable_caching: z.boolean().default(false).optional(),
			personalization_enabled: z.boolean().default(false).optional(),
			article_type: z
				.string()
				.default("Ask OpenEvidence Light with citations")
				.optional(),
			variant_configuration_file: z.string().default("prod").optional(),
			save_artifacts: z.boolean().default(true).optional(),
			crossref_validate: z.boolean().default(true).optional(),
			include_bibtex: z.boolean().default(true).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const timeoutMs = (args.timeout_sec ?? 120) * 1000;
			const intervalMs = args.poll_interval_ms ?? config.pollIntervalMs;
			let articleId = "";
			let article: Record<string, unknown> = {};
			let note: string | undefined;
			
			// Browser-driven: the real browser does the (DataDome-fronted) POST;
			// we recover the new article id by diffing history (a read, not blocked).
			const runViaBrowser = async (reason?: string): Promise<void> => {
				if (args.original_article_id) {
					note = `${reason ? `${reason} ` : ""}via_browser does not support follow-ups yet; ran as a fresh question.`;
				} else if (reason) {
					note = reason;
				}
				const result = await askViaBrowser(client, config.baseUrl, {
					question: args.question,
					configName: args.variant_configuration_file ?? "prod",
					background: args.via_browser_background ?? true,
					browserApp:
						args.via_browser_app ??
						process.env.OE_MCP_BROWSER_APP ??
						detectMacDefaultBrowserApp(),
					timeoutMs,
					pollIntervalMs: intervalMs,
					onProgress: (message) =>
						process.stderr.write(`[oe_ask via_browser] ${message}\n`),
				});
				articleId = result.articleId;
				article = result.article;
			};
			
			if (args.via_browser) {
				await runViaBrowser();
			} else {
				const askPayload: OpenEvidenceAskRequest = {
					question: args.question,
					originalArticleId: args.original_article_id,
					disableCaching: args.disable_caching ?? false,
					personalizationEnabled: args.personalization_enabled ?? false,
					articleType: args.article_type,
					variantConfigurationFile: args.variant_configuration_file,
				};
			
				try {
					const created = await client.ask(askPayload);
					articleId = String(created.id ?? "");
					if (!articleId) {
						return fail("OpenEvidence returned no article id.");
					}
			
					const waitForCompletion = args.wait_for_completion ?? true;
					if (!waitForCompletion) {
						return ok({
							created,
							article_id: articleId,
							note: "Article created. Poll with oe_article_get.",
						});
					}
			
					article = await client.waitForArticle(articleId, {
						timeoutMs,
						intervalMs,
					});
				} catch (error) {
					// The ask submission (POST /api/article) is the one path DataDome
					// blocks from Node. Re-issue it through the real logged-in browser,
					// whose TLS fingerprint is unfakeable, instead of failing.
					if (!(error instanceof DataDomeChallengeError)) {
						throw error;
					}
					const relay = await getRelay();
					if (relay && relay.isConnected()) {
						process.stderr.write(
							`[oe_ask] Node POST DataDome-blocked; routing via the Brave extension relay.\n`,
						);
						const resp = await relay.request(
							{
								method: "POST",
								path: "/api/article",
								body: JSON.stringify(buildAskBody(askPayload)),
							},
							{ timeoutMs },
						);
						if (resp.status < 200 || resp.status >= 300) {
							throw new Error(
								`relay POST /api/article -> ${resp.status} ${resp.body.slice(0, 200)}`,
							);
						}
						const created = JSON.parse(resp.body) as { id?: string };
						articleId = String(created.id ?? "");
						if (!articleId) {
							throw new Error("relay POST returned no article id");
						}
						note =
							"Node POST was DataDome-blocked; submitted via the Brave extension relay.";
						article = await client.waitForArticle(articleId, { timeoutMs, intervalMs });
					} else if (config.browserFallback) {
						process.stderr.write(
							`[oe_ask] Node POST DataDome-blocked; falling back to browser. ${error.message}\n`,
						);
						await runViaBrowser(
							"Node POST was DataDome-blocked; recovered via your real logged-in browser.",
						);
					} else {
						throw error;
					}
				}
			}

			const figures = extractFigures(article);
			const answerRaw = extractAnswerText(article);
			const artifacts =
				(args.save_artifacts ?? true)
					? await saveArticleArtifacts(article, config, {
							validateWithCrossref:
								args.crossref_validate ?? config.crossrefValidate,
						})
					: null;

			return ok({
				article_id: articleId,
				status: String(article.status ?? ""),
				extracted_answer_raw: answerRaw
					? resolveVisualTags(answerRaw, figures)
					: null,
				figures,
				artifacts: formatArtifactsForResponse(
					artifacts,
					args.include_bibtex ?? true,
				),
				...(note ? { note } : {}),
			});
		}),
);

server.registerTool(
	"oe_collections_list",
	{
		title: "OpenEvidence Collections List",
		description: "List all collections owned by the authenticated user.",
	},
	async () =>
		withClient(async (client) => {
			const data = await client.listCollections();
			return ok({ collections: data, count: data.length });
		}),
);

server.registerTool(
	"oe_collections_get",
	{
		title: "OpenEvidence Collection Get",
		description:
			"Fetch a collection (incl. nested questions[] = membership list) by id.",
		inputSchema: z.object({
			collection_id: z.string().uuid(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.getCollection(args.collection_id);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_create",
	{
		title: "OpenEvidence Collection Create",
		description:
			"Create a new collection. By convention, agent-managed names start with '#'.",
		inputSchema: z.object({
			name: z.string().min(1).max(120),
			description: z.string().max(500).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.createCollection(args.name, args.description);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_add_article",
	{
		title: "OpenEvidence Collection Add Article",
		description:
			"Add a chat (article) to a collection. Idempotent in practice.",
		inputSchema: z.object({
			collection_id: z.string().uuid(),
			article_id: z.string().uuid(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.addArticleToCollection(
				args.collection_id,
				args.article_id,
			);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_db_init",
	{
		title: "Init Collections SQLite Mirror",
		description:
			"Create the local SQLite mirror at $OE_MCP_DB_PATH (default ~/.openevidence-mcp/db/oe.sqlite). Idempotent.",
	},
	async () => {
		const r = await runCollectionSort(config, ["init"]);
		if (r.code !== 0) return fail(`init failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_sync_history",
	{
		title: "Sync Chat History to SQLite",
		description:
			"Paginate /api/article/list and upsert chats. Incremental by default (stops on the first all-known page).",
		inputSchema: z.object({
			full: z.boolean().default(false).optional(),
			pages: z.number().int().min(1).max(200).optional(),
			page_size: z.number().int().min(1).max(50).default(20).optional(),
			rate_seconds: z.number().min(0.1).max(10).default(1.0).optional(),
		}),
	},
	async (args) => {
		const cliArgs: string[] = ["sync-history"];
		if (args.full) cliArgs.push("--full");
		if (args.pages !== undefined) cliArgs.push("--pages", String(args.pages));
		if (args.page_size !== undefined)
			cliArgs.push("--page-size", String(args.page_size));
		const r = await runCollectionSort(config, cliArgs, {
			rateSeconds: args.rate_seconds,
		});
		if (r.code !== 0)
			return fail(`sync-history failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_sync_db",
	{
		title: "Sync Collections + Memberships to SQLite",
		description:
			"Refresh collections and memberships from the API into local SQLite. Prunes collections + memberships the server no longer reports.",
		inputSchema: z.object({
			rate_seconds: z.number().min(0.1).max(10).default(1.0).optional(),
		}),
	},
	async (args) => {
		const r = await runCollectionSort(config, ["sync-collections"], {
			rateSeconds: args.rate_seconds,
		});
		if (r.code !== 0)
			return fail(`sync-collections failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_unsorted",
	{
		title: "List Unsorted Chats",
		description:
			"Chats with no membership in any '#'-prefixed collection. Returns {unsorted_count, shown, items[]}.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(2000).default(200).optional(),
			preview_chars: z.number().int().min(20).max(2000).default(240).optional(),
		}),
	},
	async (args) => {
		const cliArgs: string[] = ["list-unsorted", "--json"];
		if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
		if (args.preview_chars !== undefined)
			cliArgs.push("--preview-chars", String(args.preview_chars));
		const r = await runCollectionSort(config, cliArgs);
		if (r.code !== 0)
			return fail(`list-unsorted failed: ${r.stderr || r.stdout}`);
		return ok(parseStdoutJson(r.stdout));
	},
);

server.registerTool(
	"oe_collections_summary",
	{
		title: "Collections Summary",
		description:
			"Counts (chats, collections, hashtag, memberships, unsorted) + last sync timestamps.",
	},
	async () => {
		const r = await runCollectionSort(config, ["summary"]);
		if (r.code !== 0) return fail(`summary failed: ${r.stderr || r.stdout}`);
		return ok(parseStdoutJson(r.stdout));
	},
);

server.registerTool(
	"oe_collections_classify",
	{
		title: "Auto-Classify Unsorted Chats",
		description:
			"Predict hashtags for every unsorted chat (or all chats with reclassify_all). Combines curated keyword rules with a per-tag log-odds-ratio signature trained from your existing memberships. Returns the proposed plan as JSON; use oe_collections_bulk_apply to actually write.",
		inputSchema: z.object({
			reclassify_all: z.boolean().default(false).optional(),
			threshold: z.number().min(0).max(50).default(8).optional(),
			top_k: z.number().int().min(1).max(10).default(3).optional(),
			top_n_terms: z.number().int().min(5).max(100).default(20).optional(),
			rules_only: z.boolean().default(false).optional(),
			no_rules: z.boolean().default(false).optional(),
		}),
	},
	async (args) => {
		const tmp = path.join(tmpdir(), `oe-classify-${Date.now()}.json`);
		const cliArgs: string[] = [
			"--threshold",
			String(args.threshold ?? 8),
			"--top-k",
			String(args.top_k ?? 3),
			"--top-n-terms",
			String(args.top_n_terms ?? 20),
		];
		if (args.rules_only) cliArgs.push("--rules-only");
		if (args.no_rules) cliArgs.push("--no-rules");
		cliArgs.push("classify", "--output", tmp, "--quiet");
		if (args.reclassify_all) cliArgs.push("--reclassify-all");
		const r = await runClassify(cliArgs);
		if (r.code !== 0) return fail(`classify failed: ${r.stderr || r.stdout}`);
		const fs = await import("node:fs/promises");
		const plan = JSON.parse(await fs.readFile(tmp, "utf8"));
		await fs.unlink(tmp).catch(() => {});
		const counts: Record<string, number> = {};
		for (const e of plan as { hashtags: string[] }[]) {
			for (const t of e.hashtags) counts[t] = (counts[t] ?? 0) + 1;
		}
		return ok({ plan, count: plan.length, tag_distribution: counts });
	},
);

server.registerTool(
	"oe_collections_bulk_apply",
	{
		title: "Bulk-Apply Hashtag Plan",
		description:
			"For each {article_id, hashtags[]} entry: ensure each '#'-prefixed collection exists, then add the article to it. Idempotent. Refuses non-'#' tags.",
		inputSchema: z.object({
			plan: z.array(
				z.object({
					article_id: z.string().uuid(),
					hashtags: z.array(z.string().regex(/^#/)).min(1),
				}),
			),
			descriptions: z.record(z.string(), z.string()).optional(),
			rate_seconds: z.number().min(0.1).max(10).default(0.5).optional(),
		}),
	},
	async (args) => {
		return await withTempPlan(
			args.plan,
			args.descriptions,
			async ({ planPath, descriptionsPath }) => {
				const cliArgs: string[] = ["bulk-apply", planPath];
				if (descriptionsPath) cliArgs.push("--descriptions", descriptionsPath);
				const r = await runCollectionSort(config, cliArgs, {
					rateSeconds: args.rate_seconds,
				});
				if (r.code !== 0)
					return fail(`bulk-apply failed: ${r.stderr || r.stdout}`);
				return ok({ message: r.stdout.trim() });
			},
		);
	},
);

function formatArtifactsForResponse(
	artifacts: Awaited<ReturnType<typeof saveArticleArtifacts>> | null,
	includeBibtex: boolean,
) {
	if (!artifacts) {
		return null;
	}
	if (includeBibtex) {
		return artifacts;
	}
	const { bibtex, ...rest } = artifacts;
	return rest;
}

async function withClient(
	fn: (client: OpenEvidenceClient) => Promise<{
		content: { type: "text"; text: string }[];
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	}>,
) {
	const client = new OpenEvidenceClient(config);
	if (config.relayTransport === "all") {
		const relay = await getRelay();
		if (relay && relay.isConnected()) client.useRelay(relay);
	}
	try {
		await client.init();
		const auth = await client.getAuthStatus();
		if (!auth.authenticated) {
			return fail(
				`Session is not authenticated (status ${auth.statusCode}). Paste fresh browser cookies into ${config.cookiesPath} and run: npm run login`,
			);
		}
		return await fn(client);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(message);
	} finally {
		await client.close();
	}
}

function ok(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		structuredContent: toStructured(data),
	};
}

function fail(message: string) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: message }],
	};
}

function toStructured(data: unknown): Record<string, unknown> {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		return data as Record<string, unknown>;
	}
	return { value: data };
}

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	const message =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`[openevidence-mcp] fatal: ${message}\n`);
	process.exit(1);
});
