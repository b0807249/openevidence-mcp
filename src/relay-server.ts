import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * In-process relay between the MCP server and a Brave/Chrome extension.
 *
 * The extension long-polls `GET /poll`; when the MCP server issues a request we
 * hand it `{method, path, body}`, the extension runs that `fetch` *inside* a
 * parked OpenEvidence tab (page-context Origin/Referer/cookies/TLS ⇒ DataDome
 * passes), then posts the `{status, body}` back to `POST /result`. The extension
 * is a generic authenticated fetch proxy — all OpenEvidence logic stays in Node.
 *
 * The long-poll doubles as a keepalive for the MV3 service worker. Localhost-only,
 * single-client. No WebSocket dependency — a held HTTP response is the one push.
 */

const POLL_HOLD_MS = 25_000; // how long a /poll request is held before a 204
const CONNECTED_SLACK_MS = 8_000; // grace beyond POLL_HOLD before we call it gone
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BODY_BYTES = 4_000_000;

/** A request for the extension to run inside the OpenEvidence tab. */
export interface RelayRequest {
  method: string;
  path: string;
  /** Pre-serialized request body (JSON string), or undefined for GET/HEAD. */
  body?: string;
}

/** The raw response the extension read from the in-tab fetch. */
export interface RelayResponse {
  status: number;
  body: string;
}

interface PendingReq {
  reqId: string;
  req: RelayRequest;
  resolve: (value: RelayResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayServer {
  readonly port: number;
  /** True while the extension is actively long-polling (recently seen). */
  isConnected(): boolean;
  /** Run a request through the extension; resolves with its raw {status, body}. */
  request(req: RelayRequest, opts?: { timeoutMs?: number }): Promise<RelayResponse>;
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

  const pending = new Map<string, PendingReq>();
  const outbox: PendingReq[] = [];
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

  const deliver = (res: ServerResponse, p: PendingReq): void => {
    sendJson(res, 200, { reqId: p.reqId, req: p.req });
    log(`relay: delivered ${p.req.method} ${p.req.path} (${p.reqId})`);
  };

  // Deliver queued requests to waiting long-polls, while both exist.
  const flush = (): void => {
    while (waiters.length > 0 && outbox.length > 0) {
      const p = outbox.shift();
      if (!p) break;
      if (!pending.has(p.reqId)) continue; // already timed out
      const waiter = waiters.shift();
      if (!waiter) {
        outbox.unshift(p);
        break;
      }
      clearTimeout(waiter.timer);
      deliver(waiter.res, p);
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
      const p = outbox.find((x) => pending.has(x.reqId));
      if (p) {
        outbox.splice(outbox.indexOf(p), 1);
        deliver(res, p);
        return;
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
            status?: number;
            body?: string;
            error?: string;
          };
          const p = data.reqId ? pending.get(data.reqId) : undefined;
          if (!p) {
            sendJson(res, 404, { ok: false, error: "unknown reqId" });
            return;
          }
          clearTimeout(p.timer);
          pending.delete(p.reqId);
          if (data.error) {
            p.reject(new Error(`extension: ${data.error}`));
          } else {
            p.resolve({ status: data.status ?? 0, body: data.body ?? "" });
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((err: unknown) => sendJson(res, 400, { ok: false, error: String(err) }));
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  function isConnected(): boolean {
    return now() - lastPollAt < POLL_HOLD_MS + CONNECTED_SLACK_MS;
  }

  function request(req: RelayRequest, opts?: { timeoutMs?: number }): Promise<RelayResponse> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    counter += 1;
    const reqId = `req-${counter}-${now().toString(36)}`;
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        const i = outbox.findIndex((x) => x.reqId === reqId);
        if (i >= 0) outbox.splice(i, 1);
        reject(new Error(`relay: extension did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      const p: PendingReq = { reqId, req, resolve, reject, timer };
      pending.set(reqId, p);
      outbox.push(p);
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
        request,
        close: () => {
          for (const w of waiters) clearTimeout(w.timer);
          for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error("relay server closed"));
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
