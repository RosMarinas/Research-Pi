import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

// One installation's state directory is shared by every research workspace.
export async function persistentWebToken(stateRoot) {
	const directory = join(stateRoot, "web");
	const path = join(directory, "token");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try { await writeFile(path, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 }); }
	catch (error) { if (error.code !== "EEXIST") throw error; }
	await chmod(path, 0o600);
	const token = (await readFile(path, "utf8")).trim();
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid persisted Web token: " + path);
	return token;
}
