// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The CLI: the same daemon and the same tools as the MCP front door, for agents that only have a
 * shell, for CI, and for a human checking what is connected.
 *
 *   chili3d-mcp start [--app-url <url>] [--port <n>] [--no-open]
 *   chili3d-mcp stop | restart | open | status
 *   chili3d-mcp list [--full] | schema <tool> | call <tool> [--json <f|->] | shot [file]
 *   chili3d-mcp init --agent claude|codex|cursor|workbuddy|generic [--user] [--dir <path>]
 *   chili3d-mcp mcp
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callTool, status as health, listTools, rpc } from "./client.mjs";
import { ensureDaemon, startDaemon, stopDaemon } from "./control.mjs";
import { init } from "./init.mjs";
import { DEFAULT_APP_URL, NOT_RUNNING } from "./session.mjs";

export async function main(argv) {
    try {
        await dispatch(argv);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

async function dispatch(argv) {
    const [command, ...rest] = argv;
    switch (command) {
        case "mcp":
            return mcp(rest);
        case "start":
            return start(rest);
        case "stop":
            return stop();
        case "restart":
            return restart(rest);
        case "open":
            return open(rest);
        case "status":
            return print(await health());
        case "list":
            return list(rest);
        case "schema":
            return schema(rest[0]);
        case "call":
            return call(rest);
        case "shot":
            return shot(rest[0]);
        case "init":
            return init(rest);
        default:
            return help();
    }
}

async function mcp(argv) {
    // Loaded lazily so the CLI does not pull the MCP SDK for a plain `start`.
    const { startMcp } = await import("./mcp.mjs");
    await startMcp({ appUrl: flagValue(argv, "--app-url") ?? DEFAULT_APP_URL });
}

async function start(argv) {
    const flags = parseFlags(argv);
    const appUrl = typeof flags["app-url"] === "string" ? flags["app-url"] : DEFAULT_APP_URL;
    const { started, health: info } = await startDaemon({
        appUrl,
        port: typeof flags.port === "number" ? flags.port : undefined,
        open: flags["no-open"] !== true,
    });
    console.log(`[chili3d-mcp] ${started ? "listening" : "already running"} on 127.0.0.1:${info.port}`);
    console.log(`[chili3d-mcp] open: ${info.url}`);
    console.log(`[chili3d-mcp] page connected: ${info.connected ? "yes" : "no"}`);
}

async function stop() {
    const result = await stopDaemon();
    if (result.stopped) return console.log(`[chili3d-mcp] stopped (port ${result.port})`);
    if (result.reason === "still-running") {
        return console.log(
            `[chili3d-mcp] the daemon on port ${result.port} did not exit; the session file is kept`,
        );
    }
    console.log(NOT_RUNNING);
}

async function restart(argv) {
    const result = await stopDaemon();
    if (result.reason === "still-running") {
        throw new Error(`the daemon on port ${result.port} did not exit; stop it manually and retry`);
    }
    return start(argv);
}

async function open(argv) {
    const value = flagValue(argv, "--app-url");
    const appUrl = typeof value === "string" ? value : DEFAULT_APP_URL;
    await ensureDaemon(appUrl);
    const reply = await rpc({ method: "open" });
    console.log(reply.content);
}

async function list(argv) {
    const tools = await listTools();
    if (argv.includes("--full")) return print(tools);
    if (!tools.length) return console.log("(no page connected — run: chili3d-mcp open)");
    for (const tool of tools) console.log(`${tool.name} — ${firstSentence(tool.description)}`);
}

async function schema(name) {
    if (!name) throw new Error("usage: chili3d-mcp schema <tool>");
    const tool = (await listTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    print({ name: tool.name, description: tool.description, parameters: tool.parameters });
}

async function call(argv) {
    const parsed = parseCallArgs(argv);
    const name = parsed.positional[0];
    if (!name) throw new Error("usage: chili3d-mcp call <tool> [--json <file|->] [--timeout <ms>]");
    const args = parsed.json ? JSON.parse(await readJsonArg(parsed.json)) : {};
    const reply = await callTool(name, args, parsed.timeout);
    if (!reply.ok) throw new Error(reply.content);
    print(await summarize(reply));
}

async function shot(file) {
    const reply = await callTool("capture_screenshot", {});
    if (!reply.ok) throw new Error(reply.content);
    const image = reply.images?.[0];
    if (!image) throw new Error("capture_screenshot returned no image");
    const target = file ?? `shot-${Date.now()}.${image.mediaType === "image/jpeg" ? "jpg" : "png"}`;
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(target, bytes);
    print({ file: target, mediaType: image.mediaType, bytes: bytes.length });
}

/** Images are written beside the caller and reported by size, never printed as base64. */
async function summarize(reply) {
    const payload = parseContent(reply.content);
    if (!reply.images?.length) return payload;
    const written = [];
    for (const [index, image] of reply.images.entries()) {
        const extension = image.mediaType === "image/jpeg" ? "jpg" : "png";
        const file = join(process.cwd(), `shot-${Date.now()}-${index}.${extension}`);
        const bytes = Buffer.from(image.data, "base64");
        await writeFile(file, bytes);
        written.push({ file, mediaType: image.mediaType, bytes: bytes.length });
    }
    return typeof payload === "object" && payload !== null
        ? { ...payload, images: written }
        : { content: payload, images: written };
}

function parseContent(content) {
    try {
        return JSON.parse(content);
    } catch {
        return content;
    }
}

async function readJsonArg(pathOrDash) {
    if (pathOrDash !== "-") return readFile(pathOrDash, "utf8");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

function parseCallArgs(argv) {
    const parsed = { json: undefined, timeout: undefined, positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") parsed.json = argv[++i];
        else if (arg === "--timeout") parsed.timeout = Number(argv[++i]) || undefined;
        else if (!arg.startsWith("--")) parsed.positional.push(arg);
    }
    return parsed;
}

function parseFlags(argv) {
    const parsed = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) continue;
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            parsed[argv[i].slice(2)] = true;
            continue;
        }
        parsed[argv[i].slice(2)] = argv[++i];
    }
    if ("port" in parsed) parsed.port = parsePort(parsed.port);
    return parsed;
}

function parsePort(value) {
    // `--port` with no value reaches here as `true`, and Number(true) is 1.
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error("--port needs a value");
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535 (got ${value})`);
    }
    return port;
}

function flagValue(argv, flag) {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    // `--app-url --no-open` means the value is missing, not "--no-open".
    return value === undefined || value.startsWith("--") ? undefined : value;
}

function firstSentence(description) {
    const match = description.match(/^[\s\S]*?[.!?](\s|$)/);
    return (match?.[0] ?? description).trim();
}

function print(value) {
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function help() {
    console.log(
        [
            "usage: chili3d-mcp <command>",
            "",
            "  mcp [--app-url <url>]       speak MCP over stdio (what an MCP client runs)",
            "  start [--app-url <url>]     start the background bridge and open the page",
            "        [--port <n>] [--no-open]",
            "  stop | restart | open       manage the background bridge",
            "  status                      whether the bridge and a page are connected",
            "  list [--full]               the tools the page exposes",
            "  schema <tool>               one tool's JSON schema",
            "  call <tool> [--json <f|->]  run a page tool; args from a file or stdin",
            "        [--timeout <ms>]",
            "  shot [file]                 capture the viewport to a file",
            "  init --agent <name>         write the entry file for an agent",
            "                              (claude, codex, cursor, workbuddy, generic)",
        ].join("\n"),
    );
}
