import { defineConfig } from "@rspack/cli";
import rspack from "@rspack/core";
import { TsCheckerRspackPlugin } from "ts-checker-rspack-plugin";
import packages from "./package.json";

// Shared rules / parser / resolve used by both Node and Web configs.
const shared = {
    module: {
        parser: {
            "css/module": {
                // Chili3D code uses default-import style:
                //   import style from "./foo.module.css"
                namedExports: false,
            },
        },
        rules: [
            {
                test: /\.ts$/,
                loader: "builtin:swc-loader",
                options: {
                    jsc: {
                        parser: {
                            syntax: "typescript",
                            decorators: true,
                        },
                        target: "esnext",
                    },
                },
            },
            {
                test: /\.wasm$/,
                type: "asset",
            },
            {
                test: /\.module\.css$/,
                type: "css/module",
            },
            {
                test: /\.cur$/,
                type: "asset/resource",
            },
        ],
    },
    resolve: {
        extensions: [".ts", ".js"],
    },
};

export default [
    // ── Node targets: MCP server + demo scripts ──────────────────────────
    defineConfig({
        ...shared,
        name: "node",
        target: "node",
        entry: {
            server: "./src/server.ts",
            demo: "./scripts/demo-loop.ts",
        },
        module: {
            ...shared.module,
            parser: {
                ...shared.module.parser,
                javascript: {
                    // Don't resolve new URL() as a module dependency — the wasm file is
                    // read via readFileSync at runtime (Node) or fetched (Web), not bundled.
                    url: false,
                },
            },
        },
        externalsType: "module",
        externals: [
            ({ request }, callback) => {
                if (request && /^@modelcontextprotocol\//.test(request)) {
                    return callback(undefined, request);
                }
                if (request && ["zod", "ws"].includes(request)) {
                    return callback(undefined, request);
                }
                callback();
            },
        ],
        output: {
            filename: "[name].mjs",
            module: true,
        },
    }),

    // ── Web target: browser application ──────────────────────────────────
    defineConfig({
        ...shared,
        name: "web",
        target: "web",
        entry: {
            main: "./src/main.ts",
        },
        resolve: {
            extensions: [".ts", ".js", ".json", ".wasm"],
        },
        plugins: [
            new TsCheckerRspackPlugin(),
            new rspack.CircularDependencyRspackPlugin({
                failOnError: true,
                exclude: /node_modules/,
            }),
            new rspack.CopyRspackPlugin({
                patterns: [
                    {
                        from: "./chili3d/public",
                        globOptions: {
                            ignore: ["**/**/index.html"],
                        },
                    },
                ],
            }),
            new rspack.DefinePlugin({
                __APP_VERSION__: JSON.stringify(packages.version),
                __DOCUMENT_VERSION__: JSON.stringify(packages.documentVersion),
                __IS_PRODUCTION__: JSON.stringify(process.env["NODE_ENV"] === "production"),
            }),
            new rspack.HtmlRspackPlugin({
                template: "./chili3d/public/index.html",
                inject: "body",
            }),
        ],
        optimization: {
            minimizer: [
                new rspack.SwcJsMinimizerRspackPlugin({
                    minimizerOptions: {
                        mangle: {
                            keep_classnames: true,
                            keep_fnames: true,
                        },
                    },
                }),
                new rspack.LightningCssMinimizerRspackPlugin(),
            ],
        },
    }),
];
