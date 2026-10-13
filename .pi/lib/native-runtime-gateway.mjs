import {createConnection,createServer} from 'node:net';
import {chmod,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createWebGateway} from './web-server.mjs';
import {persistentWebToken} from './web-token.mjs';

// Gateway is disposable. Native UI callbacks and permission requests remain in Host.
export async function createNativeGateway({record,stateRoot,assetsRoot,port=0,publicOrigin,tailscaleLogin,onHostDisconnect=()=>{}}) {
 let bridge,gateway,buffer='',state={ready:false,cwd:record.cwd},closed=false;const pending=new Map();
 const terminalSocket=createConnection(record.terminalSocket),terminalWaiters=[];let terminalBuffer='';
 terminalSocket.on('error',()=>{});
 terminalSocket.on('close',()=>{for(const w of terminalWaiters)w.reject(new Error('Host disconnected'));terminalWaiters.length=0;if(!closed)onHostDisconnect()});
 terminalSocket.on('connect',()=>terminalSocket.write(JSON.stringify({type:'attach',observer:true,instance:record.instance})+'\n'));
 const input=data=>terminalSocket.write(JSON.stringify({type:'input',data,instance:record.instance})+'\n');
 terminalSocket.on('data',data=>{terminalBuffer+=data;let end;while((end=terminalBuffer.indexOf('\n'))>=0){const event=JSON.parse(terminalBuffer.slice(0,end));terminalBuffer=terminalBuffer.slice(end+1);if(event.type==='terminal_snapshot'){terminalWaiters.shift()?.resolve(event);}else gateway?.broadcast(event)}});
 const server=createServer(socket=>{
  bridge?.destroy();bridge=socket;buffer='';socket.on('error',()=>{});
  socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
   if(event.type==='response'){const waiter=pending.get(event.id);pending.delete(event.id);if(waiter){event.error?waiter.reject(new Error(event.error)):waiter.resolve(event.result)}}
   else if(event.type==='show_link'){}else{if(event.type==='state')state=event.state;gateway?.broadcast(event)}
  }});
  socket.on('close',()=>{if(bridge!==socket)return;bridge=undefined;for(const waiter of pending.values())waiter.reject(new Error('Native bridge disconnected'));pending.clear();state={...state,ready:false};gateway?.broadcast({type:'state',state})});
 });
 await unlink(record.bridgeSocket).catch(e=>{if(e.code!=='ENOENT')throw e});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(record.bridgeSocket,resolve)});await chmod(record.bridgeSocket,0o600);
 const command=async request=>{
  if(request.method==='state'&&!bridge)return state;if(!bridge)throw new Error('Native bridge is reconnecting');
  const id=randomUUID();const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});bridge.write(JSON.stringify({...request,id,type:'command'})+'\n')});
  if(result?.terminalEnter)input('\r');return result;
 };
 gateway=await createWebGateway({port,publicOrigin,tailscaleLogin,assetsRoot,token:await persistentWebToken(stateRoot),command,
  terminal:{write:input,resize:(cols,rows)=>terminalSocket.write(JSON.stringify({type:'resize',cols,rows,instance:record.instance})+'\n'),snapshot:()=>new Promise((resolve,reject)=>{if(terminalSocket.destroyed)return reject(new Error('Terminal disconnected'));terminalWaiters.push({resolve,reject});terminalSocket.write(JSON.stringify({type:'attach',observer:true,instance:record.instance})+'\n')})}});
 return {...gateway,command,async close(){if(closed)return;closed=true;bridge?.destroy();terminalSocket.destroy();for(const w of terminalWaiters)w.reject(new Error('Gateway closed'));await gateway.close();await new Promise(r=>server.close(r));await unlink(record.bridgeSocket).catch(e=>{if(e.code!=='ENOENT')throw e})}};
}
