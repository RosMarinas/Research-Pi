import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, appendFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import researchCompaction from '../.pi/extensions/research-compaction.ts';
import {createRuntimeMailboxWatcher} from '../.pi/lib/runtime-mailbox-watch.mjs';
import {reserveRuntimeCompaction, runtimeCompactionReserved} from '../.pi/lib/runtime-compaction-gate.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(check) {
 const deadline = Date.now()+2000;
 while (!check()) { if(Date.now()>deadline) throw Error('Mailbox did not resume'); await tick(); }
}
function compactor() {
 const handlers = new Map(); let options; let idle = true; let pending = false;
 const ctx = {cwd:'/synthetic',sessionManager:{getSessionId:()=>crypto.randomUUID()},
  hasUI:false, getContextUsage:()=>({tokens:600000}), isIdle:()=>idle, hasPendingMessages:()=>pending,
  compact: o => {options=o;}};
 // Stable session identity, like the native sessionManager facade.
 const id=crypto.randomUUID();ctx.sessionManager.getSessionId=()=>id;
 researchCompaction({on:(n,h)=>handlers.set(n,h),registerCommand(){}});
 return {handlers,ctx,get options(){return options},set idle(v){idle=v},set pending(v){pending=v}};
}
for (const outcome of ['onComplete','onError']) {
 test(`automatic compact reserves mailbox until ${outcome}, not merely session_compact`, async()=>{
  const f=compactor();f.handlers.get('turn_end')({},f.ctx);f.handlers.get('agent_settled')({},f.ctx);
  assert.equal(runtimeCompactionReserved(f.ctx),true);assert.equal(f.options,undefined);
  await tick();assert.ok(f.options);f.handlers.get('session_compact')({},f.ctx);
  assert.equal(runtimeCompactionReserved(f.ctx),true,'native event precedes actual idle');
  f.options[outcome](new Error('synthetic failure'));
  assert.equal(runtimeCompactionReserved(f.ctx),false);
 });
}
for (const cause of ['idle','pending']) {
 test(`automatic compact does not abort continuation when ${cause} changes after settle`,async()=>{
  const f=compactor();f.handlers.get('turn_end')({},f.ctx);f.handlers.get('agent_settled')({},f.ctx);
  f[cause]=cause==='idle'?false:true;await tick();assert.equal(f.options,undefined);
  assert.equal(runtimeCompactionReserved(f.ctx),false);
  f.idle=true;f.pending=false;f.handlers.get('agent_settled')({},f.ctx);await tick();
  assert.ok(f.options,'deferred request survives to the next safe settle');f.options.onComplete();
 });
}
test('shutdown cancels a scheduled compact and releases the old session reservation',async()=>{
 const f=compactor();f.handlers.get('turn_end')({},f.ctx);f.handlers.get('agent_settled')({},f.ctx);
 f.handlers.get('session_shutdown')({},f.ctx);await tick();assert.equal(f.options,undefined);
 assert.equal(runtimeCompactionReserved(f.ctx),false);
});
for (const outcome of ['success','failure']) {
 test(`mail queued during compact resumes after ${outcome} without another ledger write`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'rpi-mail-compact-'));const ledgerPath=join(root,'ledger');writeFileSync(ledgerPath,'');
  const ctx={cwd:root,sessionManager:{getSessionId:()=>root},isIdle:()=>idle};
  let idle=false, queued=true, deliveries=0,scans=0;
  const release=reserveRuntimeCompaction(ctx);
  const watcher=createRuntimeMailboxWatcher({intervalMs:15,retryWhen:()=>!idle||runtimeCompactionReserved(ctx),
   drain:async()=>{scans++;if(!idle||runtimeCompactionReserved(ctx)||!queued)return 0;queued=false;deliveries++;return 1;}});
  try {
   watcher.start({ledgerPath},ctx);appendFileSync(ledgerPath,'one queued message\n');await until(()=>scans>0);
   watcher.wake();await tick();assert.equal(deliveries,0);
   release();idle=true;await until(()=>deliveries===1);await tick();assert.equal(deliveries,1);
  } finally {release();watcher.stop();rmSync(root,{recursive:true});}
 });
}
test('a stopped watcher cannot resume delivery after a later idle transition',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rpi-mail-stop-'));const ledgerPath=join(root,'ledger');writeFileSync(ledgerPath,'');
 let idle=false,scans=0,deliveries=0;
 const watcher=createRuntimeMailboxWatcher({intervalMs:15,retryWhen:()=>!idle,
  drain:async()=>{scans++;if(idle)deliveries++;return 0;}});
 try {watcher.start({ledgerPath},{});watcher.wake();await until(()=>scans>0);watcher.stop();idle=true;
  await tick();await tick();assert.equal(deliveries,0);
 } finally {watcher.stop();rmSync(root,{recursive:true});}
});
test('watcher startup scans existing mail without relying on a first stat change',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rpi-mail-start-'));const ledgerPath=join(root,'ledger');writeFileSync(ledgerPath,'already queued\n');
 let queued=true,deliveries=0;
 const watcher=createRuntimeMailboxWatcher({intervalMs:15,drain:async()=>{if(!queued)return 0;queued=false;deliveries++;return 1;}});
 try{watcher.start({ledgerPath},{});await until(()=>deliveries===1);await tick();assert.equal(deliveries,1);}
 finally{watcher.stop();rmSync(root,{recursive:true});}
});
