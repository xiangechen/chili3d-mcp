#!/usr/bin/env node
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { main } from "../src/cli.mjs";

await main(process.argv.slice(2));
