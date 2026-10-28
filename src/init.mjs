// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Per-agent adapters. The transport and the knowledge live in the MCP server; all this writes is
 * the few lines each tool needs to find it, plus the entry note that tells the model to bootstrap.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GUIDE } from "./guide.mjs";

const SERVER_KEY = "chili3d";
const SERVER_COMMAND = { command: "npx", args: ["-y", "@chili3d/mcp", "mcp"] };
const START = "<!-- chili3d-mcp:start -->";
const END = "<!-- chili3d-mcp:end -->";

export async function init(argv) {
    const flags = parseFlags(argv);
    const agent = typeof flags.agent === "string" ? flags.agent : "generic";
    const root =
        flags.user === true ? homedir() : resolve(typeof flags.dir === "string" ? flags.dir : process.cwd());

    switch (agent) {
        case "claude":
            return claude(root);
        case "codex":
        case "generic":
            return agentsFile(root, agent);
        case "cursor":
            return cursor(root);
        case "workbuddy":
            return workbuddy(root, flags.write === true);
        default:
            throw new Error(`unknown agent: ${agent} (claude, codex, cursor, workbuddy, generic)`);
    }
}

async function claude(root) {
    const file = join(root, ".claude", "skills", "chili3d", "SKILL.md");
    const body = [
        "---",
        "name: chili3d",
        "description: Drive the Chili3D web app in a real browser — build or edit geometry, read the document, and screenshot the viewport.",
        "---",
        "",
        GUIDE,
        "",
    ].join("\n");
    await write(file, body);
    console.log(`[chili3d-mcp] wrote ${file}`);
    console.log("[chili3d-mcp] register the server once:");
    console.log("    claude mcp add chili3d -- npx -y @chili3d/mcp mcp");
}

async function agentsFile(root, agent) {
    const file = join(root, "AGENTS.md");
    await writeBlock(file, GUIDE);
    console.log(`[chili3d-mcp] wrote ${file}`);
    if (agent === "codex") {
        console.log("[chili3d-mcp] add this to ~/.codex/config.toml:");
        console.log(`\n[mcp_servers.${SERVER_KEY}]\ncommand = "npx"\nargs = ["-y", "@chili3d/mcp", "mcp"]\n`);
    } else {
        console.log("[chili3d-mcp] point your MCP client at:");
        console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: SERVER_COMMAND } }, null, 4));
    }
}

async function cursor(root) {
    const file = join(root, ".cursor", "rules", "chili3d.mdc");
    await write(
        file,
        `---\ndescription: Drive the Chili3D web app through the chili3d MCP server\n---\n\n${GUIDE}\n`,
    );
    console.log(`[chili3d-mcp] wrote ${file}`);
    console.log("[chili3d-mcp] add this to .cursor/mcp.json:");
    console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: SERVER_COMMAND } }, null, 4));
}

async function workbuddy(root, shouldWrite) {
    const file = join(root, ".workbuddy", "mcp.json");
    if (!shouldWrite) {
        console.log(`[chili3d-mcp] add this to ${file} (and trust the server in the sidebar):`);
        console.log(JSON.stringify({ mcpServers: { [SERVER_KEY]: SERVER_COMMAND } }, null, 4));
        console.log("[chili3d-mcp] re-run with --write to merge it in.");
        return;
    }
    let config = {};
    try {
        config = JSON.parse(await readFile(file, "utf8"));
    } catch {
        // No file yet, or not JSON — a fresh one is written below.
    }
    config.mcpServers = { ...config.mcpServers, [SERVER_KEY]: SERVER_COMMAND };
    await write(file, `${JSON.stringify(config, null, 4)}\n`);
    console.log(`[chili3d-mcp] wrote ${file}`);
    console.log("[chili3d-mcp] now trust the server in WorkBuddy: sidebar → Plugins → MCP Servers.");
}

/** Insert or replace the marked block, so a re-run updates the note instead of stacking copies. */
async function writeBlock(file, body) {
    let existing = "";
    try {
        existing = await readFile(file, "utf8");
    } catch {
        // New file.
    }
    const block = `${START}\n${body}\n${END}`;
    const start = existing.indexOf(START);
    const end = existing.indexOf(END);
    let next;
    if (start >= 0 && end > start) {
        next = existing.slice(0, start) + block + existing.slice(end + END.length);
    } else {
        // An unclosed START (no END, or END before it) is still our block: cut from START instead of
        // appending a second one that can never be closed.
        const head = start >= 0 ? existing.slice(0, start) : existing;
        next = `${head.trim() ? `${head.trimEnd()}\n\n` : ""}${block}\n`;
    }
    await write(file, next);
}

async function write(file, content) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
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
    return parsed;
}
