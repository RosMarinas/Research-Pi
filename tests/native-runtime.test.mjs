import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
import {SettingsManager} from '@earendil-works/pi-coding-agent';
import {Text} from '@earendil-works/pi-tui';
import {fauxProvider,fauxAssistantMessage} from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
import {createResearchSessionRuntime} from '../.pi/lib/native-runtime-factory.mjs';
import {createNativeRuntimeHost} from '../.pi/lib/native-runtime-host.mjs';
process.env.PI_OFFLINE='1';
async function until(check){const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error('Expected native behavior did not occur');await new Promise(r=>setTimeout(r,20))}}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'native-pi-'));await mkdir(join(root,'sessions'));
 const faux=fauxProvider();faux.setResponses([fauxAssistantMessage('Native loop reply')]);let custom=false,answer;
 const runtime=await createResearchSessionRuntime({cwd:root,args:['--no-extensions','--no-skills','--no-themes','--no-context-files'],agentDir:join(root,'agent'),sessionDir:join(root,'sessions'),model:faux.getModel(),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},quietStartup:true,theme:'dark'}),extensionFactories:[pi=>{
  pi.registerProvider(faux.provider);
  pi.registerCommand('probe-custom',{description:'custom renderer',handler:async(_a,ctx)=>{custom=true;await ctx.ui.custom((_tui,_theme,_keys,done)=>({render:()=>['ORIGINAL CUSTOM VIEW'],invalidate(){},handleInput:d=>{if(d==='\r')done()}}))}});
  pi.registerCommand('probe-dialog',{description:'retained approval',handler:async(_a,ctx)=>{answer=await ctx.ui.confirm('Native approval','Approval survives terminal detach')}});
  pi.registerCommand('probe-new',{description:'native command context',handler:async(_a,ctx)=>{await ctx.newSession({withSession:async fresh=>fresh.ui.setEditorText('native restored draft')})}});
 }]});
 const instance=crypto.randomUUID(),terminalSocket=join(root,'terminal.sock');const host=await createNativeRuntimeHost({runtime,instance,terminalSocket});
 return {root,runtime,host,instance,terminalSocket,get custom(){return custom},get answer(){return answer},async close(){await host.close();await rm(root,{recursive:true,force:true})}};
}
function submit(host,text){host.terminal.input('\x1b[200~'+text+'\x1b[201~');host.terminal.input('\r')}
test('complete original InteractiveMode preserves custom UI, approval, model menu and native command context',async()=>{
 const f=await fixture();try{
  await until(()=>f.host.mode.onInputCallback);
  submit(f.host,'/probe-custom');await until(()=>f.custom);await until(async()=> (await f.host.terminal.snapshot()).data.includes('ORIGINAL CUSTOM VIEW'));
  f.host.terminal.input('\r');await until(()=>f.host.mode.onInputCallback);
  submit(f.host,'/model');await until(()=>f.host.mode.extensionSelector||f.host.mode.activeSelectorToken);f.host.terminal.input('\x1b');await new Promise(r=>setTimeout(r,100));
  submit(f.host,'/probe-dialog');await until(async()=> (await f.host.terminal.snapshot()).data.includes('Native approval'));
  const socket=createConnection(f.terminalSocket);await new Promise(r=>socket.once('connect',r));socket.write(JSON.stringify({type:'attach',instance:f.instance})+'\n');socket.destroy();
  assert.equal(f.answer,undefined);assert.equal(f.host.state().ready,true);
  f.host.terminal.resize(64,20);f.host.terminal.input('\r');await until(()=>f.answer!==undefined);
  const old=f.runtime.session.sessionId;submit(f.host,'/probe-new');await until(()=>f.runtime.session.sessionId!==old);await until(()=>f.host.mode.editor.getText().includes('native restored draft'));
  f.host.terminal.input('\x1b[D');await until(async()=> (await f.host.terminal.snapshot()).data.includes('native restored draft')); 
 }finally{await f.close()}
});
test('native quit detaches presentation, retains Host and the unmodified native model loop',async()=>{
 const f=await fixture();try{
  await until(()=>f.host.mode.onInputCallback);submit(f.host,'plain user message');await until(()=>f.runtime.session.messages.some(m=>m.role==='assistant'));assert.equal(f.runtime.session.messages.filter(m=>m.role==='user').length,1);
  await f.host.mode.shutdown();assert.equal(f.host.state().ready,true);assert.equal(f.runtime.session.messages.at(-1).role,'assistant');
  f.host.terminal.resize(80,24);assert.match((await f.host.terminal.snapshot()).data,/Native loop reply/);
 }finally{await f.close()}
});
test('external editing and suspend are dispatched to the desktop client rather than the Host process',async()=>{
 const f=await fixture();const socket=createConnection(f.terminalSocket);let buffer='',action;
 socket.on('data',d=>{buffer+=d;let end;while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(event.type==='client_action')action=event}});
 try{
  await new Promise(r=>socket.once('connect',r));socket.write(JSON.stringify({type:'attach',instance:f.instance})+'\n');await new Promise(r=>setTimeout(r,30));
  socket.write(JSON.stringify({type:'input',data:'\x07',instance:f.instance})+'\n');await until(()=>action?.action==='external-editor');
  socket.write(JSON.stringify({type:'action_result',id:action.id,result:{status:'complete',content:'edited locally'},instance:f.instance})+'\n');await until(()=>f.host.mode.editor.getText()==='edited locally');
  action=undefined;socket.write(JSON.stringify({type:'input',data:'\x1a',instance:f.instance})+'\n');await until(()=>action?.action==='suspend');assert.equal(f.host.state().ready,true);
  socket.write(JSON.stringify({type:'action_result',id:action.id,result:{},instance:f.instance})+'\n');
 }finally{socket.destroy();await f.close()}
});
