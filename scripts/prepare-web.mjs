// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without the executable
// bit. Its own install script only checks that the directory exists.
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
if (process.platform === "darwin") {
	const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", "darwin-" + process.arch, "spawn-helper");
	try {
		const info = await stat(helper);
		if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o111);
	} catch (error) {
		if (error.code !== "ENOENT") throw error; // Source builds do not use this helper.
	}
}
