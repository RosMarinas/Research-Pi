// Offline review only. No credentials or running user workspaces are loaded.
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findNativeRuntime} from '../.pi/lib/native-runtime-launcher.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'rpi-native-review-')),workspace=join(temporary,'project'),stateRoot=join(temporary,'state');await mkdir(workspace);
const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','TERM','COLORTERM'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
Object.assign(env,{RESEARCH_PI_DEV_MODE:'0',RESEARCH_PI_CONFIG_DIR:join(temporary,'config'),RESEARCH_PI_STATE_DIR:stateRoot,PI_OFFLINE:'1',EDITOR:process.execPath+' '+join(root,'tests/fixtures/native-external-editor.mjs')});
const args=[join(root,'bin/pi.mjs'),'native-runtime','start','--workspace',workspace,'--web','--web-port','8793','--provider','web-demo','--model','demo','-e',join(root,'tests/fixtures/web-demo.ts')];
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(output.replace(/#token=[^\s]+/g,'#token=[redacted]'))))});
const record=await findNativeRuntime(stateRoot,workspace);await mkdir(join(root,'output/runtime-review'),{recursive:true});await writeFile(join(root,'output/runtime-review/native-access.json'),JSON.stringify({temporary,workspace,stateRoot,env,record}),{mode:0o600});
console.log(JSON.stringify({origin:new URL(record.localUrl).origin,hostPid:record.pid,gatewayPid:record.gatewayPid}));
