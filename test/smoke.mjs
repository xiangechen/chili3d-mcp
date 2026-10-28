// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The daemon + CLI loop, without a browser: a fake page takes the WebSocket and answers calls.
 *
 *   node test/smoke.mjs
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    answerHeld,
    assert,
    connectPage,
    freePort,
    health,
    pageStats,
    ROOT,
    runCli,
    session,
    stopDaemon,
    waitFor,
} from "./helpers.mjs";

const home = await mkdtemp(join(tmpdir(), "chili3d-mcp-smoke-"));
const port = await freePort();
let daemon;

try {
    daemon = spawn(process.execPath, [join(ROOT, "src", "daemon.mjs"), "--port", String(port)], {
        // The daemon only accepts the origin of --app-url; the fake page claims the dev server.
        env: { ...process.env, CHILI3D_MCP_HOME: home, CHILI3D_APP_URL: "http://localhost:8080" },
        stdio: "ignore",
    });

    await waitFor(async () => (await health(port)).ok, "the daemon to listen");
    const page = await connectPage(port);
    await waitFor(async () => (await health(port)).connected, "the fake page to connect");

    const status = await runCli(home, ["status"]);
    assert(status.code === 0, `status exited ${status.code}: ${status.err}`);
    const parsed = JSON.parse(status.out);
    assert(parsed.connected === true, "status should report a connected page");
    assert(parsed.toolCount === 3, `status should count the page's tools (got ${parsed.toolCount})`);
    assert(parsed.busy === null, "a fresh bridge should not be busy");

    const list = await runCli(home, ["list"]);
    assert(list.out.includes("echo"), "list should contain the echo tool");

    const call = await runCli(home, ["call", "echo", "--json", "-"], JSON.stringify({ value: "hello" }));
    assert(call.code === 0, `call exited ${call.code}: ${call.err}`);
    assert(JSON.parse(call.out).echoed.value === "hello", "call should round-trip its arguments");

    const image = join(home, "shot.png");
    const shot = await runCli(home, ["shot", image]);
    assert(shot.code === 0, `shot exited ${shot.code}: ${shot.err}`);
    assert((await stat(image)).size > 0, "shot should write a file");

    const missing = await runCli(home, ["call", "nope"]);
    assert(missing.code === 1, "an unknown tool should exit 1");

    // --- the busy state machine ---------------------------------------------------------------
    // A call that times out keeps the seat: the page may still be working, and reloading it would
    // lose an unsaved document.
    const timedOut = await runCli(home, ["call", "silent", "--timeout", "300"]);
    assert(timedOut.code === 1, "a timed-out call should exit 1");
    assert(timedOut.err.includes("timed out"), `expected a timeout, got: ${timedOut.err}`);

    const stuck = await health(port);
    assert(stuck.connected === true, "the page keeps the seat after a timeout");
    assert(stuck.busy?.name === "silent", "status should say which tool the page is stuck on");

    const before = pageStats.received.length;
    const blocked = await runCli(home, ["call", "echo", "--json", "-"], JSON.stringify({ value: "x" }));
    assert(blocked.code === 1, "a call while busy should exit 1");
    assert(blocked.err.includes("still running silent"), `expected a busy failure, got: ${blocked.err}`);
    assert(pageStats.received.length === before, "a call while busy must not reach the page");

    // The late result is its own release path: the content is dropped, the seat opens.
    answerHeld(page);
    await waitFor(async () => (await health(port)).busy === null, "the late result to release the seat");
    const recovered = await runCli(home, ["call", "echo", "--json", "-"], JSON.stringify({ value: "y" }));
    assert(recovered.code === 0, `the page should be usable again: ${recovered.err}`);

    // The other release path: the page goes away while busy.
    const second = await runCli(home, ["call", "silent", "--timeout", "300"]);
    assert(second.code === 1, "the second timeout should also exit 1");
    assert((await health(port)).busy?.name === "silent", "the second timeout should set busy again");
    page.close();
    await waitFor(async () => (await health(port)).busy === null, "a disconnect to release the seat");
    assert((await health(port)).connected === false, "the page should be gone");

    assert((await session(home))?.port === port, "the session file should name the daemon's port");
    console.log("smoke: ok");
} finally {
    daemon?.kill();
    await stopDaemon(home);
    await rm(home, { recursive: true, force: true });
}
