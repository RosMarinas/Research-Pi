import { mkdir, readFile, writeFile, realpath, stat, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { withOwnerFileLock } from "./owner-file-lock.mjs";

export const harnessDirectory = (stateRoot) => join(stateRoot, "harness");
export const projectId = (cwd, analysis = false) => createHash("sha256").update(cwd).digest("hex").slice(0, 20) + (analysis ? "-analysis" : "");
export async function readHarnessProjects(stateRoot) {
	try { return JSON.parse(await readFile(join(harnessDirectory(stateRoot), "projects.json"), "utf8")); }
	catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
export async function registerHarnessProject(stateRoot, cwd, { name, analysis = false } = {}) {
	cwd = await realpath(cwd); if (!(await stat(cwd)).isDirectory()) throw new Error("Choose an existing project directory");
	const directory = harnessDirectory(stateRoot); await mkdir(directory, { recursive: true, mode: 0o700 });
	return withOwnerFileLock(join(directory, "projects.lock"), async () => {
		const projects = await readHarnessProjects(stateRoot), id = projectId(cwd, analysis);
		let project = projects.find((p) => p.id === id);
		if (!project) { project = { id, cwd, name: name?.trim().slice(0, 120) || basename(cwd), analysis, addedAt: new Date().toISOString() }; projects.push(project); }
		else if (name?.trim()) project.name = name.trim().slice(0, 120);
		await writeFile(join(directory, "projects.json"), JSON.stringify(projects), { mode: 0o600 }); return project;
	});
}
export async function discoverHarnessProjects(stateRoot) {
	const folders = await readdir(join(stateRoot, "hosts")).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
	for (const folder of folders) {
		let record; try { record = JSON.parse(await readFile(join(stateRoot, "hosts", folder, "runtime.json"), "utf8")); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
		try { process.kill(record.pid, 0); } catch (e) { if (e.code === "ESRCH") continue; throw e; }
		let cwd; try { cwd = await realpath(record.cwd); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
		const id = projectId(cwd, folder.endsWith("-analysis"));
		if (!(await readHarnessProjects(stateRoot)).some((p) => p.id === id)) await registerHarnessProject(stateRoot, cwd, { analysis: folder.endsWith("-analysis") });
	}
	return readHarnessProjects(stateRoot);
}
