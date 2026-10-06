import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {findNativeRuntime,stopNativeGateway} from '../.pi/lib/native-runtime-launcher.mjs';
import {attachResidentTerminal,residentRequest} from '../.pi/lib/web-terminal.mjs';
const a=JSON.parse(await readFile(new URL('../output/runtime-review/native-access.json',import.meta.url))),record=await findNativeRuntime(a.stateRoot,a.workspace),action=process.argv[2]??'status';
if(!record)throw new Error('Offline review is not running');
if(action==='tui')await attachResidentTerminal(record);
else if(action==='open'){const child=spawn(process.platform==='darwin'?'open':'xdg-open',[record.localUrl],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Browser open failed')))})}
else if(action==='stop'){await stopNativeGateway(record);await residentRequest(record,'stop');console.log('Stopped only the offline native review owner.')}
else if(action==='status')console.log(JSON.stringify({origin:new URL(record.localUrl).origin,hostPid:record.pid,gatewayPid:record.gatewayPid,state:record.state}));
else throw Error('Usage: node scripts/native-runtime-review.mjs [tui|open|status|stop]');
