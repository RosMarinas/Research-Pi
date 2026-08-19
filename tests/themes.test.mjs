import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("all bundled Research Pi themes pass the Pi Core theme schema", () => {
	const directory = resolve(new URL("../.pi/themes", import.meta.url).pathname);
	const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
	assert.deepEqual(files, ["research-ember.json", "research-graphite.json", "research-pi.json"]);
	const themes = files.map((file) => loadThemeFromPath(join(directory, file), "truecolor"));
	assert.deepEqual(themes.map((theme) => theme.name).sort(), ["research-ember", "research-graphite", "research-pi"]);
	for (const theme of themes) {
		assert.match(theme.fg("accent", "sample"), /sample/);
		assert.match(theme.bg("customMessageBg", "sample"), /sample/);
	}
});
