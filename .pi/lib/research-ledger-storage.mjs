import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip), expand = promisify(gunzip);
const hash = value => createHash("sha256").update(value).digest("hex");

export async function replaceResearchFile(path, content, { mode = 0o600 } = {}) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { mode, flag: "wx" });
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

export function researchArchiveDescriptor(text) {
	let first;
	try { first = JSON.parse(text.split("\n", 1)[0]); } catch { return null; }
	return first?.type === "branch.archive.storage" ? first : null;
}

export async function readResearchLedgerText(runtime, { metadata = false } = {}) {
	let text;
	try { text = await readFile(runtime.ledgerPath, "utf8"); }
	catch (error) { if (error.code === "ENOENT") return metadata ? { text: "" } : ""; throw error; }
	const descriptor = researchArchiveDescriptor(text);
	if (!descriptor) return metadata ? { text } : text;
	const data = descriptor.data;
	if (descriptor.projectKey !== runtime.projectKey || descriptor.branchId !== runtime.branchId
		|| !/^events-[a-f0-9-]+\.jsonl\.gz$/.test(data?.file ?? "")) throw new Error("Invalid archived research ledger reference");
	const bytes = await readFile(join(dirname(runtime.ledgerPath), data.file));
	if (hash(bytes) !== data.sha256) throw new Error("Archived research ledger checksum mismatch");
	const history = await expand(bytes);
	if (history.length !== data.uncompressedBytes) throw new Error("Archived research ledger size mismatch");
	const expanded = history.toString("utf8") + text.slice(text.indexOf("\n") + 1);
	return metadata ? { text: expanded, archivePath: join(dirname(runtime.ledgerPath), data.file) } : expanded;
}

// Called only while holding the branch ledger lock. The archive is immutable;
// the small ledger pointer is published after its complete contents exist.
export async function compressResearchLedger(runtime) {
	const raw = await readFile(runtime.ledgerPath, "utf8");
	const existing = researchArchiveDescriptor(raw);
	if (existing) return { uncompressedBytes: existing.data.uncompressedBytes, unchanged: true };
	const text = await readResearchLedgerText(runtime);
	const bytes = await compress(Buffer.from(text));
	const file = `events-${randomUUID()}.jsonl.gz`;
	await replaceResearchFile(join(dirname(runtime.ledgerPath), file), bytes);
	const pointer = { version: 1, projectKey: runtime.projectKey, branchId: runtime.branchId,
		id: `archive-storage-${randomUUID()}`, type: "branch.archive.storage", at: new Date().toISOString(),
		data: { file, sha256: hash(bytes), uncompressedBytes: Buffer.byteLength(text) } };
	await replaceResearchFile(runtime.ledgerPath, `${JSON.stringify(pointer)}\n`, { mode: 0o400 });
	return { compressedBytes: bytes.length, uncompressedBytes: pointer.data.uncompressedBytes };
}

export async function expandResearchLedger(runtime) {
	const raw = await readFile(runtime.ledgerPath, "utf8");
	const descriptor = researchArchiveDescriptor(raw);
	if (!descriptor) return;
	const text = await readResearchLedgerText(runtime);
	await replaceResearchFile(runtime.ledgerPath, text);
	await rm(join(dirname(runtime.ledgerPath), descriptor.data.file), { force: true });
}
