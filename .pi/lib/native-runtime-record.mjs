import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

// Readers poll these records during startup. Publish only complete JSON.
export async function publishNativeRecord(path, record) {
 const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
 try {
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
 } finally {
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
 }
}

export async function readNativeRecord(path) {
 const contents = await readFile(path, 'utf8');
 try { return JSON.parse(contents); }
 catch (error) { throw new Error(`Invalid native Runtime record ${path}: ${error.message}`, { cause: error }); }
}
