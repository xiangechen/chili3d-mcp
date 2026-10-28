// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The real thing: a headless Chrome loads a build that carries the `?bridge=` connector, the page
 * connects back, and the CLI drives it — document, a box, a screenshot. Needs a running app:
 *
 *   npm run dev                                  # in the Chili3D repo, on :8080
 *   npm run test:browser                         # add --keep to leave Chrome up
 *
 * `--app-url` defaults to http://localhost:8080; set CHROME when Chrome is somewhere else.
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageUrl } from "../src/session.mjs";
import { assert, health, runCli, session, stopDaemon, waitFor } from "./helpers.mjs";

const args = process.argv.slice(2);
const appUrl = flagValue("--app-url") ?? "http://localhost:8080";
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const keep = args.includes("--keep");

const home = await mkdtemp(join(tmpdir(), "chili3d-mcp-browser-"));
const profile = await mkdtemp(join(tmpdir(), "chili3d-mcp-chrome-"));
let chrome;

try {
    await access(chromePath).catch(() => {
        throw new Error(`Chrome not found at ${chromePath}; set CHROME=/path/to/chrome`);
    });

    const started = await runCli(home, ["start", "--no-open", "--app-url", appUrl]);
    assert(started.code === 0, `start failed: ${started.err || started.out}`);
    const { port } = await session(home);

    chrome = spawn(
        chromePath,
        [
            "--headless=new",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--enable-unsafe-swiftshader",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--window-size=1280,900",
            pageUrl(appUrl, port),
        ],
        { stdio: "ignore" },
    );

    await waitFor(async () => (await health(port)).connected, "the page to connect back", 90000);
    console.log("[browser] page connected");

    const doc = JSON.parse((await runCli(home, ["call", "get_document_state"])).out);
    if (!doc.hasActiveDocument) {
        const created = await runCli(
            home,
            ["call", "new_document", "--json", "-"],
            JSON.stringify({ name: "Browser E2E" }),
        );
        assert(created.code === 0, `new_document failed: ${created.err || created.out}`);
        console.log("[browser] created a document");
    }

    const program = {
        ops: [{ id: "box1", method: "box", args: { dx: 40, dy: 30, dz: 20 } }],
    };
    const created = await runCli(home, ["call", "run_program", "--json", "-"], JSON.stringify(program));
    assert(created.code === 0, `run_program failed: ${created.err || created.out}`);
    console.log("[browser] run_program:", created.out.trim().slice(0, 200));

    const after = JSON.parse((await runCli(home, ["call", "get_document_state"])).out);
    assert(after.nodeCount >= 1, "the document should hold the new node");
    assert(after.hasActiveDocument === true, "the document should still be active");

    const image = join(home, "shot.jpg");
    const shot = await runCli(home, ["shot", image]);
    assert(shot.code === 0, `shot failed: ${shot.err || shot.out}`);
    const bytes = (await stat(image)).size;
    assert(bytes > 1000, `screenshot looks empty (${bytes} bytes)`);
    console.log(`[browser] screenshot ${bytes} bytes`);
    console.log("browser: ok");
} catch (error) {
    console.error(`[browser] failed: ${error.message}`);
    throw error;
} finally {
    await stopDaemon(home);
    if (!keep) {
        chrome?.kill("SIGKILL");
        // Chrome releases its profile a moment after the signal; a leftover directory is not a
        // test failure, so the cleanup never throws over the result above.
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
}

function flagValue(flag) {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}
