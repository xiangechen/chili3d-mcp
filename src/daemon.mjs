// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The background half of the bridge: accepts the page's WebSocket and exposes its tool surface
 * over a loopback HTTP endpoint that the MCP front door and the CLI both use.
 *
 * It is deliberately small and stateless beyond the session: no model, no API key, no assets, no
 * geometry. The page owns the document and every tool; this process only forwards.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
    clearSession,
    DEFAULT_APP_URL,
    DEFAULT_PORT,
    PROTOCOL,
    pageUrl,
    RUN_DIR,
    SESSION_FILE,
    writeSession,
} from "./session.mjs";

const WS_OPEN = 1;
const RPC_TIMEOUT_MS = 180_000;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_WS_BYTES = 32 * 1024 * 1024;

let options;
try {
    options = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error(`[chili3d-mcp] ${messageOf(error)}`);
    process.exit(1);
}
const { port, appUrl } = options;
/** The one origin allowed to take the page seat: whoever `--app-url` points at. */
const APP_ORIGIN = new URL(appUrl).origin;
const startedAt = new Date().toISOString();

/** The one page allowed to drive this bridge. A second connection replaces the first. */
let browser;
/**
 * A call that timed out but whose page never answered. The seat is kept — reloading would lose an
 * unsaved document — but nothing new is sent until the late result arrives or the page reconnects:
 * that keeps the serial guarantee without punishing a legitimately slow `run_program`.
 */
let busy;
let tools = [];
/** Bumped on every hello, so a client can tell a re-listing is needed without diffing the tools. */
let toolsVersion = 0;
const pending = new Map();

const server = createServer(async (req, res) => {
    if (!localHost(req)) return json(res, 403, { ok: false, content: "loopback only" });
    try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname === "/health") return json(res, 200, health());
        if (url.pathname === "/rpc" && req.method === "POST") return await rpc(req, res);
        json(res, 404, { ok: false, content: "not found" });
    } catch (error) {
        json(res, error?.status ?? 500, { ok: false, content: messageOf(error) });
    }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });

server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (pathname !== "/ws" || !localHost(req) || !originAllowed(req.headers.origin)) {
        // A browser always sends Origin; a client that omits it is not the page this bridge is for.
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
        ws.isAlive = true;
    });
    // An unhandled 'error' on an EventEmitter throws: one malformed frame from the page would take
    // the whole bridge down. The close that follows cleans up the seat.
    ws.on("error", (error) => {
        console.error(`[chili3d-mcp] page socket error: ${messageOf(error)}`);
        ws.terminate();
    });

    const helloTimeout = setTimeout(() => ws.close(4003, "no hello"), HELLO_TIMEOUT_MS);
    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (msg.type === "hello") {
            clearTimeout(helloTimeout);
            if (msg.protocol !== PROTOCOL) return ws.close(4003, "protocol mismatch");
            if (browser && browser !== ws) {
                // The calls in flight belonged to the page that is going away; fail them now
                // instead of letting them time out against a page that will never answer.
                failPending("The page was replaced by a newer connection.");
                browser.close(4002, "replaced by a newer page");
            }
            browser = ws;
            busy = undefined;
            tools = Array.isArray(msg.tools) ? msg.tools : [];
            toolsVersion += 1;
            return;
        }
        if (msg.type === "result") {
            // A result nobody is waiting for is the tail of a timed-out call: it releases the seat
            // and its content is dropped, since the caller already got its failure.
            if (busy?.id === msg.id) busy = undefined;
            const entry = pending.get(msg.id);
            if (!entry) return;
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
        }
    });
    ws.on("close", () => {
        clearTimeout(helloTimeout);
        if (browser !== ws) return;
        browser = undefined;
        busy = undefined;
        tools = [];
        toolsVersion += 1;
        failPending("The Chili3D page disconnected.");
    });
});

const heartbeat = setInterval(() => {
    if (!browser) return;
    if (browser.isAlive === false) return browser.terminate();
    browser.isAlive = false;
    browser.ping();
}, 30_000);

server.on("error", (error) => {
    console.error(`[chili3d-mcp] ${messageOf(error)}`);
    process.exit(1);
});

await mkdir(RUN_DIR, { recursive: true });
server.listen(port, "127.0.0.1", async () => {
    await writeSession({ port, pid: process.pid, appUrl, startedAt });
    console.log(`[chili3d-mcp] listening on 127.0.0.1:${port}`);
    console.log(`[chili3d-mcp] open ${pageUrl(appUrl, port)}`);
    console.log(`[chili3d-mcp] session ${SESSION_FILE}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        clearInterval(heartbeat);
        await clearSession();
        for (const client of wss.clients) client.terminate();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    });
}

// --- transport ------------------------------------------------------------------------------

function parseArgs(argv) {
    const parsed = { port: DEFAULT_PORT, appUrl: DEFAULT_APP_URL };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--port") parsed.port = parsePort(argv[++i]);
        else if (argv[i] === "--app-url") parsed.appUrl = argv[++i];
    }
    try {
        new URL(parsed.appUrl);
    } catch {
        throw new Error(`--app-url is not a valid URL: ${parsed.appUrl}`);
    }
    return parsed;
}

/** 0 is rejected too: the page finds the bridge through `?bridge=<port>`, so a random port would
 * need the session file to be read back, which this daemon does not do. */
function parsePort(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error("--port needs a value");
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535 (got ${value})`);
    }
    return port;
}

/** The bridge is loopback-only, and a Host header that is not loopback is a rebound DNS name. */
function localHost(req) {
    try {
        const hostname = new URL(`http://${req.headers.host ?? ""}`).hostname;
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
    } catch {
        return false;
    }
}

function originAllowed(origin) {
    // Exactly the configured page. A dev server is named with --app-url, so there is no reason to
    // accept every localhost port: any other local page could otherwise take the seat and inject
    // tool descriptions into the model's context.
    return origin === APP_ORIGIN;
}

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function health() {
    return {
        ok: true,
        pid: process.pid,
        connected: browser !== undefined,
        busy: busy ? { name: busy.name, since: busy.since } : null,
        toolCount: tools.length,
        toolsVersion,
        port,
        appUrl,
        url: pageUrl(appUrl, port),
        startedAt,
    };
}

// --- the clients' endpoint ------------------------------------------------------------------

async function rpc(req, res) {
    // Browsers send Origin on every cross-origin POST, and a page must never reach this: the
    // header is the one part of the request a page cannot leave out. The MCP server and the CLI
    // are not browsers.
    if (req.headers.origin) return json(res, 403, { ok: false, content: "browser requests are not allowed" });

    const body = await readJson(req);
    if (body.method === "list") return json(res, 200, { ok: true, tools });
    if (body.method === "status") return json(res, 200, { ok: true, status: health() });
    if (body.method === "open") {
        const url = pageUrl(appUrl, port);
        openBrowser(url);
        return json(res, 200, { ok: true, content: url });
    }
    if (body.method === "call")
        return json(res, 200, await callPage(body.name, body.args ?? {}, body.timeoutMs));
    json(res, 400, { ok: false, content: `unknown method: ${body.method}` });
}

function readJson(req) {
    return new Promise((resolvePromise, reject) => {
        const chunks = [];
        let size = 0;
        let rejected = false;
        req.on("data", (chunk) => {
            if (rejected) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                rejected = true;
                chunks.length = 0;
                // Keep draining instead of destroying the request: the response is still writable,
                // so the caller can report 413 rather than writing to a dead socket (which would
                // emit an unhandled 'error' on the response and kill the daemon).
                reject(httpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (rejected) return;
            try {
                resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch (error) {
                reject(httpError(400, `invalid JSON body: ${messageOf(error)}`));
            }
        });
        req.on("error", (error) => {
            if (!rejected) reject(error);
        });
    });
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/**
 * One call at a time. The page's tools are written for the in-app agent, which runs a batch
 * serially: two `run_program` calls interleaved would land in one Transaction, and a chain that
 * reads a node an earlier call created would see it appear halfway. Serializing here (rather than
 * in the page) also starts the timeout when a call actually runs, not while it waits in a queue
 * behind a long build.
 */
let queue = Promise.resolve();

function callPage(name, args, timeoutMs) {
    const run = () => callPageNow(name, args, timeoutMs);
    const result = queue.then(run, run);
    queue = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function callPageNow(name, args, timeoutMs = RPC_TIMEOUT_MS) {
    if (!browser || browser.readyState !== WS_OPEN) {
        return Promise.resolve({
            ok: false,
            content: `No Chili3D page is connected. Open ${pageUrl(appUrl, port)} and leave it in the foreground.`,
        });
    }
    if (busy) {
        // Sending anything now would interleave with a call the page is still running. Failing
        // fast beats queueing: a queued call would start after the client had already given up.
        return Promise.resolve({
            ok: false,
            content: `The page is still running ${busy.name} (started ${busy.since}); it timed out but has not answered. Wait for it to finish, or reload the tab if it never does.`,
        });
    }
    const ws = browser;
    const id = randomUUID();
    return new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            // Keep the seat and hold the queue: the page may finish legitimately, and reloading it
            // would lose an unsaved document. Only a late result (or a reconnect) clears this.
            if (browser === ws) busy = { id, name, since: new Date().toISOString() };
            resolvePromise({
                ok: false,
                content: `${name} timed out after ${timeoutMs} ms. The page may still be running it; further calls will fail until it finishes or the page reconnects.`,
            });
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, timer });
        ws.send(JSON.stringify({ type: "call", id, name, args }));
    });
}

function failPending(content) {
    for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, content });
        pending.delete(id);
    }
}

function openBrowser(url) {
    const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, argv, { detached: true, stdio: "ignore" });
    child.on("error", () =>
        console.error(`[chili3d-mcp] could not open a browser; open this yourself: ${url}`),
    );
    child.unref();
}
