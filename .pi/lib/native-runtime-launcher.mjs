import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {residentWebDirectory,findResidentWeb} from './web-resident.mjs';
import {residentControlDirectory} from './web-tmux.mjs';
import {residentRequest,attachResidentTerminal} from './web-terminal.mjs';
import {withOwnerFileLock} from './owner-file-lock.mjs';

async function directoryFor(stateRoot,cwd,analysis=false){const legacy=await residentWebDirectory(stateRoot,cwd);return join(stateRoot,'native-hosts',legacy.split('/').at(-1)+(analysis?'-analysis':''))}
async function gatewayRecord(directory){try{const r=JSON.parse(await readFile(join(directory,'native-gateway.json'),'utf8'));try{process.kill(r.pid,0);return r}catch(e){if(e.code!=='ESRCH')throw e;await unlink(join(directory,'native-gateway.json'));return null}}catch(e){if(e.code==='ENOENT')return null;throw e}}
export async function findNativeRuntime(stateRoot,cwd,analysis=false){
 const directory=await directoryFor(stateRoot,cwd,analysis);let record;try{record=JSON.parse(await readFile(join(directory,'access.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}
 try{const reply=await residentRequest(record);const gateway=await gatewayRecord(directory);return {...record,directory,state:reply.state,gatewayPid:gateway?.pid,url:gateway?.url,localUrl:gateway?.localUrl}}catch(e){try{process.kill(record.pid,0)}catch(probe){if(probe.code==='ESRCH'){await unlink(join(directory,'access.json'));return null}throw probe}throw new Error('Native Host is alive but unavailable: '+e.message)}
}
async function launch(script,options,directory,env){
 const log=await open(join(directory,script.includes('gateway')?'gateway.log':'host.log'),'a',0o600);let child;
 try{child=spawn(process.execPath,[join(options.packageRoot,'.pi/lib',script)],{cwd:options.cwd??options.record.cwd,env,detached:true,stdio:['pipe',log.fd,log.fd]})}finally{await log.close()}
 let error;child.on('error',e=>error=e);child.stdin.on('error',e=>error=e);child.stdin.end(JSON.stringify(options));child.unref();
 return {child,check(){if(error)throw error;if(child.exitCode!==null||child.signalCode)throw new Error('Native owner failed to start; see '+directory)}};
}
export async function ensureNativeGateway(options,record){
 return withOwnerFileLock(join(record.directory,'gateway.lock'),async()=>{
  const old=await gatewayRecord(record.directory);if(old)return old;
  const process=await launch('native-gateway-process.mjs',{...options,record,assetsRoot:join(options.packageRoot,'web')},record.directory,options.env);
  const end=Date.now()+35000;while(Date.now()<end){process.check();const r=await gatewayRecord(record.directory);if(r)return r;await new Promise(r=>setTimeout(r,100))}throw new Error('Native Gateway startup timed out');
 },{attempts:450,waitMs:100});
}
export async function stopNativeGateway(record){const gateway=await gatewayRecord(record.directory);if(!gateway)return;process.kill(gateway.pid,'SIGTERM');const end=Date.now()+15000;while(Date.now()<end){if(!await gatewayRecord(record.directory))return;await new Promise(r=>setTimeout(r,50))}throw new Error('Gateway is still shutting down')}
export async function launchNativeRuntime(options){
 const {stateRoot,cwd,analysis=false}=options,directory=await directoryFor(stateRoot,cwd,analysis);
 await mkdir(directory,{recursive:true,mode:0o700});
 const record=await withOwnerFileLock(join(directory,'startup.lock'),async()=>{
  const old=await findNativeRuntime(stateRoot,cwd,analysis);if(old){if(options.hasSessionOptions)throw new Error('Native Host already exists; use its original /model or /resume menus');return old}
  if(await findResidentWeb(stateRoot,cwd))throw new Error('Existing tmux resident must be stopped explicitly before migrating; it will not be replaced');
  // Never silently create a second writer next to a live rolled-back experimental Host.
  const previous=join(stateRoot,'hosts',directory.split('/').at(-1),'runtime.json');
  try{const r=JSON.parse(await readFile(previous,'utf8'));try{process.kill(r.pid,0);throw new Error('Previous experimental Host is still alive; migration requires explicit shutdown')}catch(e){if(e.code!=='ESRCH')throw e}}catch(e){if(e.code!=='ENOENT')throw e}
  const control=await residentControlDirectory(directory),instance=randomUUID();
  const process=await launch('native-runtime-process.mjs',{...options,directory,instance,terminalSocket:join(control,'native.sock'),bridgeSocket:join(control,'web.sock')},directory,options.env);
  const end=Date.now()+35000;while(Date.now()<end){process.check();const r=await findNativeRuntime(stateRoot,cwd,analysis);if(r)return r;await new Promise(r=>setTimeout(r,100))}throw new Error('Native Runtime startup timed out');
 },{attempts:450,waitMs:100});
 if(options.web.enabled){const gateway=await ensureNativeGateway(options,record);process.stderr.write('Research Pi local Web: '+gateway.localUrl+'\n');if(gateway.url!==gateway.localUrl)process.stderr.write('Research Pi mobile Web: '+gateway.url+'\n')}
 if(!options.background)await attachResidentTerminal(record);return record;
}
