// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The MCP loop: a real MCP client over stdio, the server's own daemon, and a fake page. Proves
 * the dynamic catalogue (bootstrap tools, then the page's own tools) and the image round-trip.
 *
 *   node test/mcp.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assert, BIN, connectPage, health, pageStats, session, stopDaemon, waitFor } from "./helpers.mjs";

const home = await mkdtemp(join(tmpdir(), "chili3d-mcp-e2e-"));
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp"],
    env: { ...process.env, CHILI3D_MCP_HOME: home, CHILI3D_APP_URL: "http://localhost:8080" },
    stderr: "inherit",
});
const client = new Client({ name: "test-client", version: "1.0.0" });
let page;

try {
    await client.connect(transport);

    // The MCP front door starts the daemon itself; the page connects to whichever port it chose.
    await waitFor(async () => (await session(home))?.port !== undefined, "the daemon to start");
    const { port } = await session(home);
    page = await connectPage(port);
    await waitFor(async () => (await health(port)).connected, "the fake page to connect");

    // The catalogue is dynamic: bootstrap tools first, the page's tools once its hello arrives.
    let tools = [];
    await waitFor(
        async () => {
            tools = (await client.listTools()).tools;
            return tools.some((tool) => tool.name === "chili3d_echo");
        },
        "the page tools to appear",
        15000,
    );

    const names = tools.map((tool) => tool.name);
    assert(names.includes("chili3d_open"), "chili3d_open should always be listed");
    assert(names.includes("chili3d_status"), "chili3d_status should always be listed");

    const echoed = await client.callTool({ name: "chili3d_echo", arguments: { value: "hi" } });
    assert(echoed.content[0].text.includes("hi"), "the tool call should round-trip");

    // The page's tools assume the in-app agent's serial batch; two parallel MCP calls must
    // arrive one at a time, or two run_program calls would interleave in one Transaction.
    pageStats.active = 0;
    pageStats.maxActive = 0;
    await Promise.all([
        client.callTool({ name: "chili3d_echo", arguments: { value: "a" } }),
        client.callTool({ name: "chili3d_echo", arguments: { value: "b" } }),
    ]);
    assert(pageStats.maxActive === 1, `the daemon should serialize calls (saw ${pageStats.maxActive})`);

    const shot = await client.callTool({ name: "chili3d_capture_screenshot", arguments: {} });
    assert(
        shot.content.some((part) => part.type === "image"),
        "images should come back as MCP image content",
    );

    const status = await client.callTool({ name: "chili3d_status", arguments: {} });
    assert(JSON.parse(status.content[0].text).connected === true, "status should report the page");

    console.log("mcp: ok");
} finally {
    await client.close().catch(() => {});
    page?.close();
    await stopDaemon(home);
    await rm(home, { recursive: true, force: true });
}
