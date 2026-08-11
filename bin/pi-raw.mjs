#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
if (!existsSync(coreCli)) throw new Error(`Pinned Pi core is missing: ${coreCli}`);
const child = spawn(process.execPath, [coreCli, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
