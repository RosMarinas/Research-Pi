import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
function check(executable, args) {
 const result = spawnSync(executable, args, { stdio: 'inherit' });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform !== 'win32') check('sh', ['-n', 'run-pi.sh', 'run-pi-traced.sh', 'install-user.sh']);
for (const dir of ['bin', '.pi/lib', '.pi/extensions', 'scripts']) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name)) check(process.execPath, ['--check', join(dir, entry.name)]);
 }
}
check(process.execPath, ['--check', 'web/app.js']);
console.log('Syntax checks passed.');
