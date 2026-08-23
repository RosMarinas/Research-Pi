import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cache = mkdtempSync(join(tmpdir(), "research-pi-npm-cache-"));
let output;
try {
	output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, npm_config_cache: cache },
	});
} finally {
	rmSync(cache, { recursive: true, force: true });
}
const manifest = JSON.parse(output)[0];
const files = manifest.files.map((entry) => entry.path);
const forbidden = files.filter((path) =>
	/(?:^|\/)(?:\.env|auth\.json|models-store\.json|sessions|traces|memory\.sqlite|codex\/jobs|capabilities)(?:$|\/)/.test(path),
);
assert.deepEqual(forbidden, [], `Sensitive runtime files would enter the npm package: ${forbidden.join(", ")}`);
assert.ok(!files.includes(".pi/config.json"), "The user-local Research Pi config would enter the npm package");
assert.ok(!files.some((path) => path.startsWith(".pi/agent/")), "Generated Pi agent state would enter the npm package");
for (const required of [
	"bin/pi.mjs",
	".pi/APPEND_SYSTEM.md",
	".pi/config.defaults.json",
	".pi/schemas/codex-advisor-result.json",
	".pi/schemas/research-pi-config.schema.json",
	".pi/themes/research-pi.json",
	".pi/extensions/research-config.ts",
	".pi/lib/research-config.mjs",
	"docs/configuration.md",
	".pi/extensions/project-boundary.ts",
	".pi/lib/project-boundary.mjs",
	".pi/skills/research-briefing/SKILL.md",
]) {
	assert.ok(files.includes(required), `npm package is missing ${required}`);
}
process.stdout.write(`Package manifest verified: ${files.length} files, ${manifest.size} bytes.\n`);
