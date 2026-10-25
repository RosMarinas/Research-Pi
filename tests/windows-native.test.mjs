import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeInvocation, nativeWindowsMode, psLiteral, POWERSHELL_PREAMBLE } from '../.pi/lib/windows-native.mjs';

test('npm Windows shim invokes Node with literal argv, never cmd interpolation', () => {
 const root = mkdtempSync(join(tmpdir(), 'pi-native-shim-'));
 try {
  mkdirSync(join(root,'node_modules/tool/bin'), {recursive:true});
  const entry=join(root,'node_modules/tool/bin/cli.js');writeFileSync(entry,'console.log(JSON.stringify(process.argv.slice(2)))');
  const shim=join(root,'tool.cmd');writeFileSync(shim,'@echo off\nnode.exe "%dp0%\\node_modules\\tool\\bin\\cli.js" %*');
  const args=['', 'a"b', '中文 path', '& echo injected', "$env:HOME", "O'Brien"];
  const call=nativeInvocation(shim,args,'win32');
  assert.equal(call.executable,process.execPath);
  const r=spawnSync(call.executable,call.args,{encoding:'utf8'});assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),args);
  writeFileSync(shim,'cmd.exe /c something');assert.throws(()=>nativeInvocation(shim,[],'win32'),/native executable/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('native executables retain argument arrays',()=>{
 const args=['--config','x="with spaces"'];assert.deepEqual(nativeInvocation('codex.exe',args,'win32'),{executable:'codex.exe',args});
});
test('PowerShell literals escape apostrophes without expanding metacharacters',()=>{
 assert.equal(psLiteral("C:\\用户\\O'Brien $x"),"'C:\\用户\\O''Brien $x'");
 assert.match(POWERSHELL_PREAMBLE,/PSNativeCommandUseErrorActionPreference = \$true/);
});
test('native preview rejects unsupported resident modes without rejecting prompt text',()=>{
 for(const argv of [['web','start'],['native-runtime','start'],['--web'],['--resident-runtime']]) assert.throws(()=>nativeWindowsMode(argv),/foreground/);
 assert.deepEqual(nativeWindowsMode(['--print','web']),['--print','web']);
 assert.deepEqual(nativeWindowsMode(['--','--web']),['--','--web']);
});
