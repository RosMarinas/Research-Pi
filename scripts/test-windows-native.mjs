// Real Windows smoke: disposable local files, no model requests or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { windowsPowerShell, POWERSHELL_PREAMBLE, psLiteral } from '../.pi/lib/windows-native.mjs';
import { buildSandboxRuntimeConfig } from '../.pi/lib/project-boundary.mjs';
import { resolveSystemRuntimePolicy } from '../.pi/lib/security-policy.mjs';
if (process.platform !== 'win32') throw new Error('Run this smoke on native Windows, not macOS/Linux/WSL.');
const shell = await windowsPowerShell(), run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'Research Pi 原生 '));
const workspace = join(root, "project space's"), outside = join(root, 'outside.txt');
await mkdir(workspace); await writeFile(outside, 'outside-canary'); await writeFile(join(workspace,'.env'), 'test-secret');
const runtimeTmp = join(workspace, '.runtime-tmp'); await mkdir(runtimeTmp);
const policy = await resolveSystemRuntimePolicy();
async function command(text) {
 const wrapped = await SandboxManager.wrapWithSandboxArgv(POWERSHELL_PREAMBLE + text, shell, undefined, undefined, workspace);
 try { return await run(wrapped.argv[0], wrapped.argv.slice(1), { cwd: workspace, env: { ...process.env, ...wrapped.env }, encoding: 'utf8', timeout: 20000, windowsHide: true }); }
 finally { SandboxManager.cleanupAfterCommand(); }
}
try {
 await SandboxManager.initialize(buildSandboxRuntimeConfig(workspace, process.env, policy, { access: 'write', runtimeTmp }));
 const file = join(workspace, '中文 output.txt');
 await command(`Set-Content -LiteralPath ${psLiteral(file)} -Value '中文 hello' -Encoding utf8NoBOM`);
 assert.equal((await readFile(file,'utf8')).trim(),'中文 hello');
 const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
 const values = ['', 'a"b', "space's name", '中文'];
 const result = await command(`& ${psLiteral(process.execPath)} -e ${psLiteral(code)} ${values.map(psLiteral).join(' ')}`);
 assert.deepEqual(JSON.parse(result.stdout.trim()), values);
 await assert.rejects(command(`& ${psLiteral(process.execPath)} -e 'process.exit(7)'`));
 for (const path of [outside, join(workspace,'.env')]) await assert.rejects(command(`[IO.File]::ReadAllText(${psLiteral(path)})`));
 await SandboxManager.reset();
 await SandboxManager.initialize(buildSandboxRuntimeConfig(workspace, process.env, policy, { access: 'read', runtimeTmp }));
 assert.match((await command(`Get-Content -LiteralPath ${psLiteral(file)}`)).stdout, /中文 hello/);
 await assert.rejects(command(`Set-Content -LiteralPath ${psLiteral(file)} -Value 'unexpected'`));
 assert.equal((await readFile(file,'utf8')).trim(),'中文 hello');
 console.log('PASS: PowerShell version, UTF-8, paths, argv, native failure, project boundary and read-only role.');
} finally { await SandboxManager.reset(); await rm(root,{recursive:true,force:true}); }
