// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { NOT_RUNNING, readSession } from "./session.mjs";

/**
 * The client side of the daemon: every call is one loopback HTTP request, and the daemon holds
 * the WebSocket to the page. Both the MCP front door and the CLI go through here.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 180_000;
/** Room for the daemon's own call timeout to fire first and explain itself. */
const CALL_TIMEOUT_MARGIN_MS = 20_000;

export async function requestJson(path, body, method = "POST", timeoutMs = DEFAULT_TIMEOUT_MS) {
    const session = await readSession();
    if (!session?.port) throw new Error(NOT_RUNNING);
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${session.port}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
            throw new Error(`the daemon did not answer within ${timeoutMs} ms`);
        }
        // A stale session file points at a port nothing is listening on any more.
        throw new Error(NOT_RUNNING);
    }
    if (!response.ok) {
        // The daemon puts the real reason in the body; "responded 403" alone is not actionable.
        const detail = await response.json().catch(() => undefined);
        throw new Error(
            typeof detail?.content === "string"
                ? `daemon responded ${response.status}: ${detail.content}`
                : `daemon responded ${response.status}`,
        );
    }
    try {
        return await response.json();
    } catch {
        throw new Error("the daemon returned a response that is not JSON");
    }
}

export function rpc(body) {
    const timeoutMs =
        body?.method === "call"
            ? (body.timeoutMs ?? CALL_TIMEOUT_MS) + CALL_TIMEOUT_MARGIN_MS
            : DEFAULT_TIMEOUT_MS;
    return requestJson("/rpc", body, "POST", timeoutMs);
}

export function status() {
    return requestJson("/health", undefined, "GET");
}

/** The page's tool descriptors, or an empty list when no page is connected. */
export async function listTools() {
    const reply = await rpc({ method: "list" });
    return reply.ok ? reply.tools : [];
}

/** Run one page tool. The reply is `{ ok, content, images? }`. */
export function callTool(name, args = {}, timeoutMs) {
    return rpc({ method: "call", name, args, timeoutMs });
}
