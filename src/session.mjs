// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the page lives. Override for a local build: CHILI3D_APP_URL=http://localhost:8080. */
export const DEFAULT_APP_URL = process.env.CHILI3D_APP_URL ?? "https://chili3d.com";
export const DEFAULT_PORT = 17373;
export const PROTOCOL = 1;

/**
 * Runtime state lives in the user's home, not in the package: this is a global tool, and the
 * session must survive `npx` re-materialising the package. The tests point it at a temp dir.
 */
export const RUN_DIR = process.env.CHILI3D_MCP_HOME ?? join(homedir(), ".chili3d-mcp");
export const SESSION_FILE = join(RUN_DIR, "session.json");
export const LOG_FILE = join(RUN_DIR, "daemon.log");

export async function readSession() {
    try {
        return JSON.parse(await readFile(SESSION_FILE, "utf8"));
    } catch {
        return undefined;
    }
}

export async function writeSession(session) {
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export async function clearSession() {
    await rm(SESSION_FILE, { force: true });
}

/** The page URL that asks the app to connect back to this bridge. */
export function pageUrl(appUrl, port) {
    const url = new URL(appUrl);
    url.searchParams.set("bridge", String(port));
    return url.toString();
}

export const NOT_RUNNING = "chili3d-mcp is not running. Start it with: chili3d-mcp start";
