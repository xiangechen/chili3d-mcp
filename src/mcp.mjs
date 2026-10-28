// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The MCP front door: a stdio server whose tools are the page's own tool registry. It is a
 * client of the daemon, not a second executor — the page stays the only thing that touches the
 * document.
 *
 * The page's tool list arrives with its WebSocket hello, so the catalogue is dynamic: two
 * bootstrap tools are always present, and everything else appears once a page is connected and
 * the client is told to re-list.
 */

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, listTools, rpc, status } from "./client.mjs";
import { ensureDaemon } from "./control.mjs";
import { GUIDE } from "./guide.mjs";
import { DEFAULT_APP_URL } from "./session.mjs";

const PREFIX = "chili3d_";
const POLL_MS = 1000;
const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const BOOTSTRAP = [
    {
        name: `${PREFIX}open`,
        description:
            "Start the local bridge and open the Chili3D page in the user's browser. Call this when chili3d_status reports no connected page, then leave the tab in the foreground.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: `${PREFIX}status`,
        description:
            "Report whether a Chili3D page is connected, which port the bridge is on, and how many tools the page offers.",
        inputSchema: { type: "object", properties: {} },
    },
];

export async function startMcp(options = {}) {
    const appUrl = options.appUrl ?? DEFAULT_APP_URL;
    const server = new Server(
        { name: "chili3d-mcp", version: VERSION },
        { capabilities: { tools: { listChanged: true } }, instructions: GUIDE },
    );

    let pageTools = [];
    let seen = -1;

    let refreshing;
    const refresh = async (notify) => {
        // The list handler and the poller can fire together; one fetch at a time is enough, and a
        // slow daemon must not pile up one request per second.
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const health = await status();
            if (health.toolsVersion === seen) return;
            const descriptors = health.connected ? await listTools() : [];
            pageTools = descriptors.map(toMcpTool);
            // Only after the descriptors are in hand: advancing `seen` on a failed fetch would
            // freeze the catalogue until the page reconnects.
            seen = health.toolsVersion;
            if (notify) await server.sendToolListChanged();
        })().finally(() => {
            refreshing = undefined;
        });
        return refreshing;
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        await refresh(false).catch(() => undefined);
        return { tools: [...BOOTSTRAP, ...pageTools] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        try {
            if (name === `${PREFIX}open`) {
                await ensureDaemon(appUrl);
                const reply = await rpc({ method: "open" });
                return text(`Opened ${reply.content}`);
            }
            if (name === `${PREFIX}status`) return text(JSON.stringify(await status(), null, 2));
            if (!name.startsWith(PREFIX)) return failure(`unknown tool: ${name}`);
            return toContent(await callTool(name.slice(PREFIX.length), args));
        } catch (error) {
            return failure(error instanceof Error ? error.message : String(error));
        }
    });

    await server.connect(new StdioServerTransport());
    await ensureDaemon(appUrl).catch(() => undefined);
    const timer = setInterval(() => void refresh(true).catch(() => undefined), POLL_MS);
    timer.unref();
}

function toMcpTool(tool) {
    return {
        name: `${PREFIX}${tool.name}`,
        description: tool.description,
        inputSchema: tool.parameters ?? { type: "object", properties: {} },
    };
}

function text(value) {
    return { content: [{ type: "text", text: String(value) }] };
}

function failure(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}

function toContent(reply) {
    if (!reply?.ok) return failure(reply?.content ?? "the tool failed");
    const content = [{ type: "text", text: reply.content }];
    for (const image of reply.images ?? []) {
        content.push({ type: "image", data: image.data, mimeType: image.mediaType });
    }
    return { content };
}
