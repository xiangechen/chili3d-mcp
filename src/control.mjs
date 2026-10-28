// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
    clearSession,
    DEFAULT_APP_URL,
    DEFAULT_PORT,
    LOG_FILE,
    pageUrl,
    RUN_DIR,
    readSession,
} from "./session.mjs";

const DAEMON = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
const MAX_PORT_TRIES = 10;

/** Start the background daemon. Idempotent: an answering session is returned, not replaced. */
export async function startDaemon(options = {}) {
    const appUrl = options.appUrl ?? DEFAULT_APP_URL;
    const running = await runningDaemon();
    if (running) return { started: false, health: running };

    const port = await freePort(options.port ?? DEFAULT_PORT);
    const { exit } = await spawnDaemon(port, appUrl);
    const health = await waitForHealth(port, exit);
    if (!health) throw new Error(`the daemon did not come up — see ${LOG_FILE}`);
    if (options.open !== false) openBrowser(pageUrl(appUrl, port));
    return { started: true, health };
}

/** Stop the daemon named by the session file. Safe when it is already gone. */
export async function stopDaemon() {
    const session = await readSession();
    if (!session?.pid) return { stopped: false, reason: "not-running" };

    // Never signal a pid on the session file's word alone: after a SIGKILL the file survives, and
    // the OS may have handed that pid to something unrelated. The authority is whatever answers on
    // the session's port and reports that same port back — that process is, by definition, the
    // daemon to stop. Its self-reported pid wins when it has one (an older daemon does not).
    const health = await healthAt(session.port);
    if (!health?.ok || health.port !== session.port) {
        await clearSession();
        return { stopped: false, reason: "not-running" };
    }
    const pid = Number.isInteger(health.pid) ? health.pid : session.pid;

    try {
        process.kill(pid, "SIGTERM");
    } catch (error) {
        // Already gone — the session file is the only thing left to clean up.
        if (error.code !== "ESRCH") throw error;
    }
    for (let i = 0; i < 30; i++) {
        if (!(await healthAt(session.port))) {
            await clearSession();
            return { stopped: true, port: session.port };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Still answering: keep the session file so a later stop or start can still find this daemon,
    // and let the caller report the truth instead of claiming success.
    return { stopped: false, reason: "still-running", port: session.port };
}

/** The daemon's health, when one is actually answering. A stale session file answers nothing. */
export async function runningDaemon() {
    const session = await readSession();
    if (!session?.port) return undefined;
    const health = await healthAt(session.port);
    return health?.ok ? health : undefined;
}

/** The daemon the MCP front door runs against: reuse one that is up, otherwise start quietly. */
export async function ensureDaemon(appUrl = DEFAULT_APP_URL) {
    return (await runningDaemon()) ?? (await startDaemon({ appUrl, open: false })).health;
}

export function openBrowser(url) {
    const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, argv, { detached: true, stdio: "ignore" });
    child.on("error", () =>
        console.error(`[chili3d-mcp] could not open a browser; open this yourself: ${url}`),
    );
    child.unref();
}

function freePort(from) {
    if (!Number.isInteger(from) || from < 1 || from > 65535) {
        return Promise.reject(new Error(`--port must be an integer between 1 and 65535 (got ${from})`));
    }
    return new Promise((resolvePort, reject) => {
        let port = from;
        let tries = 0;
        const attempt = () => {
            const probe = createServer();
            probe.once("error", () => {
                if (++tries >= MAX_PORT_TRIES || port >= 65535) {
                    reject(
                        new Error(`no free port in ${from}..${Math.min(from + MAX_PORT_TRIES - 1, 65535)}`),
                    );
                    return;
                }
                port++;
                attempt();
            });
            probe.once("listening", () => probe.close(() => resolvePort(port)));
            probe.listen(port, "127.0.0.1");
        };
        attempt();
    });
}

async function spawnDaemon(port, appUrl) {
    await mkdir(RUN_DIR, { recursive: true });
    const log = await open(LOG_FILE, "a");
    try {
        const child = spawn(process.execPath, [DAEMON, "--port", String(port), "--app-url", appUrl], {
            detached: true,
            stdio: ["ignore", log, log],
        });
        // Attached before the log close below: a child that dies during it must still be seen by
        // waitForHealth, which would otherwise poll for the full 15 s first.
        const exit = new Promise((resolveExit) => {
            child.once("exit", (code, signal) => resolveExit({ code, signal }));
        });
        // A failed spawn emits 'error' asynchronously; without a listener it would be an uncaught
        // exception in the CLI.
        await new Promise((resolveSpawn, rejectSpawn) => {
            child.once("spawn", resolveSpawn);
            child.once("error", rejectSpawn);
        });
        child.unref();
        return { exit };
    } finally {
        await log.close();
    }
}

async function waitForHealth(port, exitPromise) {
    // The port was free when probed, but something can take it before the daemon binds. That child
    // then exits at once, and polling alone would blame the log 15 s later.
    for (let i = 0; i < 150; i++) {
        const health = await healthAt(port);
        if (health?.ok) {
            const session = await readSession();
            if (session?.pid) return health;
        }
        // An already-settled promise settles first in array order, so a recorded exit wins here.
        const exit = await Promise.race([exitPromise, Promise.resolve(null)]);
        if (exit) {
            throw new Error(`the daemon exited (${exit.code ?? exit.signal}) — see ${LOG_FILE}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
}

const HEALTH_TIMEOUT_MS = 1000;

async function healthAt(port) {
    if (!port) return undefined;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        return response.ok ? await response.json() : undefined;
    } catch {
        return undefined;
    }
}
