import {writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createResearchSessionRuntime} from './native-runtime-factory.mjs';
import {createNativeRuntimeHost} from './native-runtime-host.mjs';
process.umask(0o077);
let host;
try {
 let input='';for await(const data of process.stdin)input+=data;
 const options=JSON.parse(input);process.env.RESEARCH_PI_WEB_SOCKET=options.bridgeSocket;
 const runtime=await createResearchSessionRuntime(options);
 host=await createNativeRuntimeHost({...options,runtime,onShutdown:async()=>{await unlink(join(options.directory,'access.json'));process.exit(0)}});
 await writeFile(join(options.directory,'access.json'),JSON.stringify({kind:'native-runtime',pid:process.pid,cwd:options.cwd,instance:options.instance,terminalSocket:options.terminalSocket,bridgeSocket:options.bridgeSocket,directory:options.directory}),{mode:0o600});
 process.once('SIGTERM',()=>void host.close());process.once('SIGINT',()=>void host.close());
}catch(error){console.error('Native Runtime: '+error.message);await host?.close();process.exitCode=1}
