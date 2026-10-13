import {createConnection} from 'node:net';
import {ProcessTerminal} from '@earendil-works/pi-tui';
import {editInExternalEditor} from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js';

export async function attachNativeTerminal(record) {
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Attach from an interactive terminal');
 const physical=new ProcessTerminal(),socket=createConnection(record.terminalSocket);let buffer='',seq=0,started=false,acting=false;
 const send=value=>{if(!socket.destroyed)socket.write(JSON.stringify({...value,instance:record.instance})+'\n')};
 const detach=()=>socket.end(),resize=()=>send({type:'resize',cols:physical.columns,rows:physical.rows});
 const input=data=>{if(acting)return;if(data==='\x1d')return detach();send({type:'capabilities',kitty:physical.kittyProtocolActive});send({type:'input',data})};
 const start=()=>{physical.start(input,resize);started=true;resize();physical.write('\x1b]10;?\x07\x1b]11;?\x07')};
 const action=async event=>{
  if(acting)return;acting=true;physical.stop();started=false;physical.write('\x1b[?1049l\x1b[?25h\x1b[0m');
  try{let result;if(event.action==='external-editor')result=await editInExternalEditor(event.params);
   else if(event.action==='suspend'&&process.platform!=='win32')await new Promise(resolve=>{process.once('SIGCONT',resolve);process.kill(process.pid,'SIGTSTP')});
   else throw new Error('Unsupported physical terminal action');send({type:'action_result',id:event.id,result});
  }catch(error){send({type:'action_result',id:event.id,error:error.message})}
  finally{acting=false;if(!socket.destroyed){start();send({type:'attach'})}}
 };
 process.on('SIGHUP',detach);process.on('SIGTERM',detach);process.stdin.on('end',detach);
 try{await new Promise((resolve,reject)=>{
  socket.on('error',reject);socket.on('close',resolve);socket.on('connect',()=>send({type:'attach'}));
  socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
   if(event.type==='terminal_snapshot'){physical.write(event.data);seq=event.seq;if(!started&&!acting)start()}
   else if(event.type==='terminal'&&event.seq>seq&&!acting){seq=event.seq;physical.write(event.data)}
   else if(event.type==='client_action')void action(event);
  }});
 })}finally{socket.destroy();if(started){await physical.drainInput(1000);physical.stop()}physical.write('\x1b[?1049l\x1b[?25h\x1b[0m\n');process.off('SIGHUP',detach);process.off('SIGTERM',detach);process.stdin.off('end',detach)}
}
