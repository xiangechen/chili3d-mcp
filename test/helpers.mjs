// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BIN = join(ROOT, "bin", "chili3d-mcp.mjs");
/** A 1×1 transparent PNG — the CLI only has to write the bytes it is given. */
export const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const TOOLS = [
    {
        name: "echo",
        description: "Echo the arguments back.",
        parameters: { type: "object", properties: { value: { type: "string" } } },
    },
    {
        name: "capture_screenshot",
        description: "Return a tiny image.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "silent",
        description: "Never answers on its own, so the daemon has to time it out.",
        parameters: { type: "object", properties: {} },
    },
];

/** How many calls the page is handling at once — the daemon must never get this above 1. */
export const pageStats = { active: 0, maxActive: 0, received: [] };

/** Calls the page deliberately never answers, so a test can drive the daemon's busy state. */
const held = new Map();

/** Answer every held call late; the daemon should drop the content and release the seat. */
export function answerHeld(ws) {
    for (const [id, message] of held) {
        ws.send(
            JSON.stringify({ type: "result", id, ok: true, content: JSON.stringify({ late: message.name }) }),
        );
        held.delete(id);
    }
}

/** A stand-in for the page: takes the WebSocket and answers the tools listed above. */
export function connectPage(port, origin = "http://localhost:8080") {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
        ws.on("open", () => {
            ws.send(JSON.stringify({ type: "hello", protocol: 1, tools: TOOLS }));
            resolve(ws);
        });
        ws.on("message", async (data) => {
            const message = JSON.parse(data.toString());
            if (message.type !== "call") return;
            pageStats.received.push(message.name);
            if (message.name === "silent") {
                held.set(message.id, message);
                return;
            }
            pageStats.active += 1;
            pageStats.maxActive = Math.max(pageStats.maxActive, pageStats.active);
            try {
                await new Promise((done) => setTimeout(done, 30));
                ws.send(JSON.stringify({ type: "result", id: message.id, ...answer(message) }));
            } finally {
                // A throwing answer() must not leave the counter up, or the serialization
                // assertion sees a false pass.
                pageStats.active -= 1;
            }
        });
        ws.on("error", reject);
    });
}

function answer(message) {
    if (message.name === "echo") return { ok: true, content: JSON.stringify({ echoed: message.args }) };
    if (message.name === "capture_screenshot") {
        return {
            ok: true,
            content: JSON.stringify({ mediaType: "image/png" }),
            images: [{ mediaType: "image/png", data: TINY_PNG }],
        };
    }
    return { ok: false, content: `unknown tool: ${message.name}` };
}

export async function session(home) {
    try {
        return JSON.parse(await readFile(join(home, "session.json"), "utf8"));
    } catch {
        return undefined;
    }
}

export async function health(port) {
    try {
        return await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    } catch {
        return {};
    }
}

export function runCli(home, argv, input) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, ...argv], {
            env: { ...process.env, CHILI3D_MCP_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (data) => (out += data));
        child.stderr.on("data", (data) => (err += data));
        child.on("close", (code) => resolve({ code, out, err }));
        child.stdin.end(input ?? "");
    });
}

export async function stopDaemon(home) {
    const current = await session(home);
    if (current?.pid) {
        try {
            process.kill(current.pid, "SIGTERM");
        } catch {
            // Already gone.
        }
    }
    await rm(join(home, "session.json"), { force: true });
}

export function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

export async function waitFor(check, what, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
}

export function assert(condition, message) {
    if (!condition) throw new Error(message);
}
