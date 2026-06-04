import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * In-process relay between the MCP server and a Brave/Chrome extension.
 *
 * The extension long-polls `GET /poll`; when an ask is submitted we hand it the
 * request body, the extension runs the `POST /api/article` *inside* a parked
 * OpenEvidence tab (page-context Origin/Referer/cookies/TLS ⇒ DataDome passes),
 * then posts the new article id to `POST /result`. The long-poll doubles as a
 * keepalive that stops the MV3 service worker from sleeping.
 *
 * Localhost-only, single-client. No WebSocket dependency — a held HTTP response
 * is enough for the one push we need.
 */

const POLL_HOLD_MS = 25_000; // how long a /poll request is held before a 204
const CONNECTED_SLACK_MS = 8_000; // grace beyond POLL_HOLD before we call it gone
const DEFAULT_SUBMIT_TIMEOUT_MS = 90_000;
const MAX_BODY_BYTES = 1_000_000;

interface PendingAsk {
  reqId: string;
  body: unknown;
  resolve: (value: { articleId: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
}

interface Waiter {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayServer {
  readonly port: number;
  /** True while the extension is actively long-polling (recently seen). */
  isConnected(): boolean;
  /** Hand a request body to the extension; resolves with the created article id. */
  submitAsk(body: unknown, opts?: { timeoutMs?: number }): Promise<{ articleId: string }>;
  close(): void;
}

export interface RelayServerOptions {
  port: number;
  host?: string;
  now?: () => number;
  logger?: (message: string) => void;
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? (() => {});

  const pending = new Map<string, PendingAsk>();
  const outbox: PendingAsk[] = [];
  const waiters: Waiter[] = [];
  let lastPollAt = 0;
  let counter = 0;

  const cors = (res: ServerResponse): void => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    cors(res);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Deliver one queued ask to one waiting long-poll, if both exist.
  const flush = (): void => {
    while (waiters.length > 0 && outbox.length > 0) {
      const ask = outbox.shift();
      if (!ask) break;
      if (!pending.has(ask.reqId)) continue; // already timed out
      const waiter = waiters.shift();
      if (!waiter) {
        outbox.unshift(ask);
        break;
      }
      clearTimeout(waiter.timer);
      ask.delivered = true;
      sendJson(waiter.res, 200, { reqId: ask.reqId, body: ask.body });
      log(`relay: delivered ask ${ask.reqId} to extension`);
    }
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && url.startsWith("/poll")) {
      lastPollAt = now();
      if (outbox.length > 0) {
        const ask = outbox.find((a) => pending.has(a.reqId));
        if (ask) {
          outbox.splice(outbox.indexOf(ask), 1);
          ask.delivered = true;
          sendJson(res, 200, { reqId: ask.reqId, body: ask.body });
          log(`relay: delivered ask ${ask.reqId} to extension (immediate)`);
          return;
        }
      }
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.res === res);
        if (i >= 0) waiters.splice(i, 1);
        sendJson(res, 204, {});
      }, POLL_HOLD_MS);
      waiters.push({ res, timer });
      res.on("close", () => {
        clearTimeout(timer);
        const i = waiters.findIndex((w) => w.res === res);
        if (i >= 0) waiters.splice(i, 1);
      });
      return;
    }

    if (method === "GET" && url.startsWith("/health")) {
      sendJson(res, 200, { ok: true, connected: isConnected(), pending: pending.size });
      return;
    }

    if (method === "POST" && url.startsWith("/result")) {
      readBody(req)
        .then((raw) => {
          const data = JSON.parse(raw) as {
            reqId?: string;
            articleId?: string;
            error?: string;
          };
          const ask = data.reqId ? pending.get(data.reqId) : undefined;
          if (!ask) {
            sendJson(res, 404, { ok: false, error: "unknown reqId" });
            return;
          }
          clearTimeout(ask.timer);
          pending.delete(ask.reqId);
          if (data.error) {
            ask.reject(new Error(`extension: ${data.error}`));
          } else if (data.articleId) {
            ask.resolve({ articleId: data.articleId });
          } else {
            ask.reject(new Error("extension returned no articleId"));
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((err: unknown) => {
          sendJson(res, 400, { ok: false, error: String(err) });
        });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  function isConnected(): boolean {
    return now() - lastPollAt < POLL_HOLD_MS + CONNECTED_SLACK_MS;
  }

  function submitAsk(
    body: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{ articleId: string }> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
    counter += 1;
    const reqId = `ask-${counter}-${now().toString(36)}`;
    return new Promise<{ articleId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        const i = outbox.findIndex((a) => a.reqId === reqId);
        if (i >= 0) outbox.splice(i, 1);
        reject(new Error(`relay: extension did not return an article within ${timeoutMs}ms`));
      }, timeoutMs);
      const ask: PendingAsk = { reqId, body, resolve, reject, timer, delivered: false };
      pending.set(reqId, ask);
      outbox.push(ask);
      flush();
    });
  }

  return new Promise<RelayServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : options.port;
      log(`relay: listening on http://${host}:${boundPort}`);
      resolve({
        port: boundPort,
        isConnected,
        submitAsk,
        close: () => {
          for (const w of waiters) clearTimeout(w.timer);
          for (const ask of pending.values()) {
            clearTimeout(ask.timer);
            ask.reject(new Error("relay server closed"));
          }
          waiters.length = 0;
          pending.clear();
          outbox.length = 0;
          server.close();
        },
      });
    });
  });
}
