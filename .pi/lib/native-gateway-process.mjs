import {unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {publishNativeRecord} from './native-runtime-record.mjs';
import {createNativeGateway} from './native-runtime-gateway.mjs';
import {inspectWebTailnet,startWebTailnet} from './web-tailscale.mjs';
process.umask(0o077);let gateway,serving;
try{let input='';for await(const d of process.stdin)input+=d;const o=JSON.parse(input);
 const tailnet=o.web.tailscale?await inspectWebTailnet({httpsPort:o.web.httpsPort,chooseAvailable:o.web.autoHttpsPort}):null;
 const path=join(o.record.directory,'native-gateway.json');
 const stop=async()=>{await serving?.stop();await gateway?.close();await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e});process.exit(0)};
 gateway=await createNativeGateway({...o,port:o.web.port,publicOrigin:tailnet?.origin,tailscaleLogin:tailnet?.login,onHostDisconnect:()=>void stop()});
 if(tailnet){serving=startWebTailnet({httpsPort:tailnet.httpsPort,localPort:gateway.port,onError:e=>console.error(e.message)});await serving.ready}
 await publishNativeRecord(path,{pid:process.pid,url:gateway.accessUrl,localUrl:gateway.localAccessUrl});
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}catch(e){console.error('Native Gateway: '+e.message);await serving?.stop();await gateway?.close();process.exitCode=1}
