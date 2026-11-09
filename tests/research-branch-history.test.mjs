import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeResearchRuntime, resolveResearchRuntime, readRuntimeSnapshot, readRuntimeEvents, appendRuntimeEvent,
 claimRuntimeActorAttachment, detachRuntimeActor, recordRuntimeEvidence, upsertRuntimeAction } from '../.pi/lib/research-runtime.mjs';
import { selectResearchBranch, listResearchBranches } from '../.pi/lib/research-branches.mjs';
import { checkpointResearchBranch, inspectResearchCheckpoint, forkResearchBranch, rewindResearchBranch,
 importResearchEvidence, archiveResearchBranch, restoreResearchBranch, doctorResearchBranches, pruneResearchBranches } from '../.pi/lib/research-branch-history.mjs';
import { openMemoryIndex, syncMemoryIndex, searchMemory, pruneMemoryIndexSources } from '../.pi/lib/research-memory.mjs';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'pi-branch-history-')); t.after(() => rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo'), runtimeRoot=join(root,'state','runtime','projects'); await mkdir(repo);
 git(repo,'init','-b','main'); git(repo,'config','user.name','Test'); git(repo,'config','user.email','test@example.invalid');
 await writeFile(join(repo,'model.txt'),'baseline\n'); git(repo,'add','model.txt'); git(repo,'commit','-m','baseline');
 const runtime=await initializeResearchRuntime(repo,{sessionId:'leader'},{runtimeRoot});
 const evidence=async(id,question=id) => recordRuntimeEvidence(runtime,{id,question,contentFingerprint:id,source:{sessionId:'leader'},runGitCommit:git(repo,'rev-parse','HEAD')});
 const checkpoint=async(label='baseline') => checkpointResearchBranch(runtime,{sessionId:'leader',label,rationale:'Preserve a decision boundary',entryId:'entry-1'});
 const detach=async()=>detachRuntimeActor(runtime,'research-leader','leader');
 return {root,repo,runtimeRoot,runtime,evidence,checkpoint,detach};
}

test('checkpoint freezes research, evidence and dirty tracked code without changing branch/index/worktree',async t=>{
 const f=await fixture(t); await appendRuntimeEvent(f.runtime,'project.state.committed',{state:{researchQuestion:'original'},source:{trackRef:'project:initial'}});
 await f.evidence('first'); await writeFile(join(f.repo,'model.txt'),'dirty snapshot\n'); await writeFile(join(f.repo,'untracked.txt'),'not included\n');
 const status=git(f.repo,'status','--porcelain'), index=git(f.repo,'write-tree'), head=git(f.repo,'rev-parse','HEAD');
 const cp=await f.checkpoint();
 assert.equal(git(f.repo,'status','--porcelain'),status); assert.equal(git(f.repo,'write-tree'),index); assert.equal(git(f.repo,'rev-parse','HEAD'),head);
 assert.equal(git(f.repo,'show',`${cp.code.commit}:model.txt`),'dirty snapshot'); assert.deepEqual(cp.code.untrackedFiles,['untracked.txt']);
 await f.evidence('later'); await appendRuntimeEvent(f.runtime,'project.state.committed',{state:{researchQuestion:'later'}});
 const frozen=await inspectResearchCheckpoint(f.runtime,cp.id); assert.equal(frozen.research.projectState.state.researchQuestion,'original');
 assert.deepEqual(frozen.research.evidence.map(e=>e.id),['first']); assert.equal(frozen.context.entryId,'entry-1');
 const next=await f.checkpoint('later'); assert.deepEqual(next.parents,[{branchId:f.runtime.branchId,checkpointId:cp.id}]);
});

test('fork creates an independent worktree from its immutable checkpoint, without inheriting live controls',async t=>{
 const f=await fixture(t); await f.evidence('frozen'); await appendRuntimeEvent(f.runtime,'project.state.committed',{state:{researchQuestion:'fork me'}});
 await writeFile(join(f.repo,'model.txt'),'checkpoint code\n'); const cp=await f.checkpoint();
 await f.evidence('future'); await writeFile(join(f.repo,'model.txt'),'new source code\n');
 await upsertRuntimeAction(f.runtime,{id:'live-job',kind:'subagent',status:'running',metadata:{role:'advisor'}});
 const created=await forkResearchBranch(f.runtime,{name:'alternative',checkpointId:cp.id,to:join(f.root,'fork')});
 const child=await resolveResearchRuntime(created.workspaceRoot,{runtimeRoot:f.runtimeRoot}), snapshot=await readRuntimeSnapshot(child);
 assert.equal(child.projectKey,f.runtime.projectKey); assert.notEqual(child.branchId,f.runtime.branchId);
 assert.deepEqual(snapshot.evidence.map(e=>e.id),['frozen']); assert.equal(snapshot.projectState.state.researchQuestion,'fork me');
 assert.equal(snapshot.attachments.length,0); assert.equal(snapshot.actions.length,0); assert.equal(snapshot.messages.length,0);
 assert.equal(await readFile(join(created.workspaceRoot,'model.txt'),'utf8'),'checkpoint code\n');
 assert.equal(await readFile(join(f.repo,'model.txt'),'utf8'),'new source code\n');
 assert.deepEqual(snapshot.forkedFrom,{branchId:f.runtime.branchId,checkpointId:cp.id});
 assert.deepEqual(snapshot.checkpoints[0].parents,[{branchId:f.runtime.branchId,checkpointId:cp.id}]);
 await initializeResearchRuntime(child.workspaceRoot,{sessionId:'child-leader'},{runtimeRoot:f.runtimeRoot});
 assert.equal((await readRuntimeSnapshot(f.runtime)).attachments[0].sessionId,'leader');
 assert.equal((await inspectResearchCheckpoint(child,created.baseCheckpointId)).research.evidence[0].inheritedFrom.branchId,f.runtime.branchId);
});

test('rewind only restores research state, keeps actual Job outcomes and code, and invalidates old Session generations',async t=>{
 const f=await fixture(t); await f.evidence('old'); await appendRuntimeEvent(f.runtime,'project.state.committed',{state:{researchQuestion:'old state'}}); const cp=await f.checkpoint();
 await f.evidence('future'); await appendRuntimeEvent(f.runtime,'project.state.committed',{state:{researchQuestion:'future state'}});
 await upsertRuntimeAction(f.runtime,{id:'completed-job',kind:'subagent',status:'completed',metadata:{summary:'Actual completed run'}});
 await writeFile(join(f.repo,'model.txt'),'current code\n');
 await assert.rejects(rewindResearchBranch(f.runtime,{authority:'user',checkpointId:cp.id,reason:'Try earlier hypothesis'}),/attached Sessions/);
 await f.detach(); const result=await rewindResearchBranch(f.runtime,{authority:'user',checkpointId:cp.id,reason:'Try earlier hypothesis'});
 assert.equal(result.codeRestored,false); const snapshot=await readRuntimeSnapshot(f.runtime);
 assert.equal(snapshot.generation,1); assert.equal(snapshot.projectState.state.researchQuestion,'old state'); assert.deepEqual(snapshot.evidence.map(e=>e.id),['old']);
 assert.equal(snapshot.actions[0].status,'completed'); assert.equal(snapshot.actions[0].metadata.generation,0);
 assert.equal(await readFile(join(f.repo,'model.txt'),'utf8'),'current code\n');
 const prior=process.env.RESEARCH_PI_RUNTIME_DIR; process.env.RESEARCH_PI_RUNTIME_DIR=f.runtimeRoot;
 t.after(()=>{if(prior===undefined)delete process.env.RESEARCH_PI_RUNTIME_DIR;else process.env.RESEARCH_PI_RUNTIME_DIR=prior;});
 const {default:extension}=await import('../.pi/extensions/research-runtime.ts'); const handlers=new Map();
 extension({on:(n,h)=>handlers.set(n,h),registerTool(){},registerCommand(){},registerMessageRenderer(){},registerEntryRenderer(){}});
 const before=await readFile(f.runtime.ledgerPath,'utf8');
 const ctx={cwd:f.repo,hasUI:false,sessionManager:{getSessionId:()=> 'leader',getBranch:()=>[{type:'custom',customType:'research-runtime-branch',data:{projectKey:f.runtime.projectKey,branchId:f.runtime.branchId,workspaceKey:f.runtime.workspaceKey,generation:0}}]}};
 await assert.rejects(handlers.get('session_start')({reason:'resume'},ctx),/rewound/);
 assert.equal(await readFile(f.runtime.ledgerPath,'utf8'),before);
});

test('checkpoint, rewind and archive reject active or unresolved work',async t=>{
 const f=await fixture(t); const cp=await f.checkpoint(); await upsertRuntimeAction(f.runtime,{id:'writer',status:'running',metadata:{role:'executor'}});
 await assert.rejects(f.checkpoint(),/writers/); await f.detach();
 await assert.rejects(rewindResearchBranch(f.runtime,{authority:'user',checkpointId:cp.id,reason:'rewind'}),/active or unresolved/);
 await assert.rejects(archiveResearchBranch(f.runtime,{authority:'user',reason:'done'}),/active or unresolved/);
 await upsertRuntimeAction(f.runtime,{id:'writer',status:'outcome_unknown'});
 await assert.rejects(archiveResearchBranch(f.runtime,{authority:'user',reason:'done'}),/active or unresolved/);
});

test('archive compresses history, rejects all writers, remains inspectable and restores losslessly',async t=>{
 const f=await fixture(t); await f.evidence('retained'); const cp=await f.checkpoint();
 for(let n=0;n<20;n++)await appendRuntimeEvent(f.runtime,'note',{body:'repeated observation '.repeat(100)});
 await assert.rejects(archiveResearchBranch(f.runtime,{authority:'user',reason:'finished'}),/attached Sessions/);
 await f.detach(); const count=(await readRuntimeEvents(f.runtime)).length;
 const result=await archiveResearchBranch(f.runtime,{authority:'user',reason:'finished'});
 assert.ok(result.compressedBytes<result.uncompressedBytes); assert.match(await readFile(f.runtime.ledgerPath,'utf8'),/branch.archive.storage/);
 assert.equal((await readRuntimeSnapshot(f.runtime)).lifecycle,'archived'); assert.equal((await readRuntimeEvents(f.runtime)).length,count+1);
 assert.equal((await inspectResearchCheckpoint(f.runtime,cp.id)).research.evidence[0].id,'retained');
 await assert.rejects(appendRuntimeEvent(f.runtime,'note',{body:'write'}),/archived/);
 await assert.rejects(claimRuntimeActorAttachment(f.runtime,'research-leader',{sessionId:'new'}),/archived/);
 assert.equal((await archiveResearchBranch(f.runtime,{authority:'user',reason:'again'})).unchanged,true);
 await restoreResearchBranch(f.runtime,{authority:'user',reason:'resume'}); assert.equal((await readRuntimeSnapshot(f.runtime)).lifecycle,'active');
 assert.equal((await readRuntimeSnapshot(f.runtime)).evidence[0].id,'retained'); assert.equal((await readRuntimeEvents(f.runtime)).length,count+2);
 assert.equal((await readdir(f.runtime.scopeDir)).filter(name=>name.endsWith('.gz')).length,0);
});

test('archive checksum and cache dependency detect tampered or missing cold storage',async t=>{
 const f=await fixture(t); await f.evidence('retained'); await f.detach(); await archiveResearchBranch(f.runtime,{authority:'user',reason:'done'});
 await readRuntimeSnapshot(f.runtime); await readRuntimeSnapshot(f.runtime);
 const pointer=JSON.parse(await readFile(f.runtime.ledgerPath,'utf8')); const path=join(f.runtime.scopeDir,pointer.data.file);
 await writeFile(path,'invalid compressed bytes'); await assert.rejects(readRuntimeSnapshot(f.runtime),/checksum/);
 await assert.rejects(restoreResearchBranch(f.runtime,{authority:'user',reason:'resume'}),/checksum/);
});

test('evidence adoption is explicit, idempotent, source-preserving and does not replace current claims',async t=>{
 const f=await fixture(t); await f.evidence('best'); const cp=await f.checkpoint();
 const created=await forkResearchBranch(f.runtime,{name:'other',checkpointId:cp.id,to:join(f.root,'other')});
 const target=await initializeResearchRuntime(created.workspaceRoot,{sessionId:'other-leader'},{runtimeRoot:f.runtimeRoot});
 await appendRuntimeEvent(target,'project.state.committed',{state:{researchQuestion:'my own question'}});
 const sourceBefore=await readFile(f.runtime.ledgerPath,'utf8');
 const input={sessionId:'other-leader',evidenceId:'best',reason:'Use this controlled comparison',interpretation:'Applies only to this architecture'};
 const result=await importResearchEvidence(target,f.runtime,input); const snapshot=await readRuntimeSnapshot(target), adopted=snapshot.evidence.find(e=>e.id===result.id);
 assert.equal(adopted.origin.branchId,f.runtime.branchId); assert.equal(adopted.origin.evidenceId,'best'); assert.ok(adopted.origin.eventId);
 assert.equal(adopted.runGitCommit,git(f.repo,'rev-parse','HEAD')); assert.equal(adopted.adoption.interpretation,input.interpretation);
 assert.equal(snapshot.projectState.state.researchQuestion,'my own question'); assert.equal(await readFile(f.runtime.ledgerPath,'utf8'),sourceBefore);
 const revision=snapshot.revision; assert.equal((await importResearchEvidence(target,f.runtime,input)).duplicate,true); assert.equal((await readRuntimeSnapshot(target)).revision,revision);
 await assert.rejects(importResearchEvidence(target,f.runtime,{...input,sessionId:'intruder'}),/attachment changed/);
 await assert.rejects(importResearchEvidence({...target,projectKey:'project-foreign'},f.runtime,input),/same project/);
});

test('an archived source can still be adopted and forked after its workspace binding is pruned',async t=>{
 const f=await fixture(t); await f.evidence('best'); const cp=await f.checkpoint(); await f.detach(); await archiveResearchBranch(f.runtime,{authority:'user',reason:'cold'});
 const created=await forkResearchBranch(f.runtime,{name:'target',checkpointId:cp.id,to:join(f.root,'target')});
 const target=await initializeResearchRuntime(created.workspaceRoot,{sessionId:'target'},{runtimeRoot:f.runtimeRoot});
 // Keep the shared Git common directory available, but remove the target-free source binding via a second source worktree below.
 const sourceFork=await forkResearchBranch(f.runtime,{name:'temporary-source',checkpointId:cp.id,to:join(f.root,'temporary-source')});
 const source=await resolveResearchRuntime(sourceFork.workspaceRoot,{runtimeRoot:f.runtimeRoot});
 await archiveResearchBranch(source,{authority:'user',reason:'cold'}); await rm(source.workspaceRoot,{recursive:true,force:true});
 const report=await pruneResearchBranches(target,{apply:true}); assert.ok(report.repaired.some(i=>i.branchId===source.branchId));
 const selected=await selectResearchBranch(target,source.branchId); assert.equal((await listResearchBranches(target)).find(b=>b.branchId===source.branchId).bindingStatus,'missing');
 const adopted=await importResearchEvidence(target,selected,{sessionId:'target',evidenceId:'best',reason:'Useful archived result'}); assert.ok(adopted.id);
 const forked=await forkResearchBranch(selected,{name:'resumed',checkpointId:sourceFork.baseCheckpointId,to:join(f.root,'resumed')}); assert.ok(forked.branchId);
});

test('doctor and prune preview are read-only; apply only removes missing-workspace indexes and dead-owner locks',async t=>{
 const f=await fixture(t); const cp=await f.checkpoint();
 const created=await forkResearchBranch(f.runtime,{name:'temporary',checkpointId:cp.id,to:join(f.root,'temporary')});
 const other=await resolveResearchRuntime(created.workspaceRoot,{runtimeRoot:f.runtimeRoot});
 const bytes=await readFile(other.ledgerPath,'utf8'); await rm(other.workspaceRoot,{recursive:true,force:true});
 const dead=join(other.scopeDir,'dead.lock'), live=join(other.scopeDir,'live.lock');
 await writeFile(dead,JSON.stringify({pid:2147483647,token:'dead'})); await writeFile(live,JSON.stringify({pid:process.pid,token:'live'}));
 const old=new Date(Date.now()-60_000); await utimes(dead,old,old); await utimes(live,old,old);
 const doctor=await doctorResearchBranches(f.runtime); assert.ok(doctor.issues.some(i=>i.code==='missing_workspace'&&i.repairable));
 const preview=await pruneResearchBranches(f.runtime); assert.equal(preview.dryRun,true); assert.equal(await readFile(dead,'utf8'),JSON.stringify({pid:2147483647,token:'dead'}));
 const result=await pruneResearchBranches(f.runtime,{apply:true}); assert.equal(result.skipped.length,0); assert.equal(result.repaired.length,2);
 await assert.rejects(readFile(dead),{code:'ENOENT'}); assert.ok(await readFile(live)); assert.equal(await readFile(other.ledgerPath,'utf8'),bytes);
 assert.equal((await listResearchBranches(f.runtime)).length,2); assert.equal((await selectResearchBranch(f.runtime,'temporary')).branchId,other.branchId);
});

test('prune refuses to reclaim missing workspaces with unresolved ownership',async t=>{
 const f=await fixture(t); const cp=await f.checkpoint(); const created=await forkResearchBranch(f.runtime,{name:'busy',checkpointId:cp.id,to:join(f.root,'busy')});
 const other=await initializeResearchRuntime(created.workspaceRoot,{sessionId:'active'},{runtimeRoot:f.runtimeRoot}); await rm(other.workspaceRoot,{recursive:true,force:true});
 const report=await pruneResearchBranches(f.runtime,{apply:true}); assert.equal(report.repaired.length,0);
 assert.ok(report.issues.some(i=>i.branchId===other.branchId&&i.code==='unresolved_ownership'));
 assert.equal((await listResearchBranches(f.runtime)).find(b=>b.branchId===other.branchId).bindingStatus,'bound');
});

test('memory generation excludes superseded Session context and handles equal-length synthetic updates',async t=>{
 const f=await fixture(t); const sessionDir=join(f.root,'sessions'); await mkdir(sessionDir);
 const session=[{type:'session',id:'old',cwd:f.repo},{type:'custom',id:'binding',customType:'research-runtime-branch',data:{projectKey:f.runtime.projectKey,branchId:f.runtime.branchId,generation:0}},
 {type:'message',id:'message',parentId:'binding',message:{role:'user',content:'marker old context'}}];
 await writeFile(join(sessionDir,'old.jsonl'),session.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const db=openMemoryIndex(join(f.root,'memory.sqlite')); t.after(()=>db.close());
 const record={path:join(f.root,'record')+'#evidence',kind:'experiment',id:'same',sessionId:'record',cwd:f.repo,timestamp:'2026-11-08',label:'record',text:'marker old result',projectKey:f.runtime.projectKey,branchId:f.runtime.branchId,generation:0};
 syncMemoryIndex(db,{sessionDir,recordSources:[record]});
 syncMemoryIndex(db,{sessionDir,recordSources:[{...record,text:'marker new result',generation:1}]});
 const query={query:'marker',currentCwd:f.repo,currentProjectKey:f.runtime.projectKey,currentBranchId:f.runtime.branchId,currentGeneration:1};
 const hits=searchMemory(db,query); assert.equal(hits.length,1); assert.match(hits[0].snippet,/new result/); assert.equal(hits[0].generation,1);
 assert.equal(searchMemory(db,{...query,scope:'project'}).length,2);
});

test('memory prune removes only missing backing sources and never deletes the shared SQLite database',async t=>{
 const f=await fixture(t); const sessionDir=join(f.root,'sessions'); await mkdir(sessionDir);
 const path=join(f.root,'memory.sqlite'), backing=join(f.root,'backing'); await writeFile(backing,'retained');
 let db=openMemoryIndex(path); syncMemoryIndex(db,{sessionDir,recordSources:[{path:backing,kind:'discussion',id:'id',sessionId:'s',cwd:f.repo,timestamp:'',label:'source',text:'known result'}]}); db.close();
 await rm(backing); const preview=pruneMemoryIndexSources(path); assert.equal(preview.sources.length,1); assert.equal(preview.removed,0);
 const applied=pruneMemoryIndexSources(path,{apply:true}); assert.equal(applied.removed,1);
 db=openMemoryIndex(path); assert.equal(db.prepare('SELECT count(*) AS n FROM memory_units').get().n,0); db.close(); assert.ok(await readFile(path));
});

test('CLI supports checkpoint, fork, inspect, adopt, archive, restore and doctor in isolated state',async t=>{
 const f=await fixture(t); await f.evidence('best'); await f.detach();
 const env={...process.env,RESEARCH_PI_STATE_DIR:join(f.root,'state'),RESEARCH_PI_RUNTIME_DIR:f.runtimeRoot};
 const cli=new URL('../bin/pi.mjs',import.meta.url).pathname;
 const run=(cwd,...args)=>JSON.parse(execFileSync(process.execPath,[cli,'branch',...args,'--json'],{cwd,env,encoding:'utf8'}));
 const cp=run(f.repo,'checkpoint','baseline'); assert.ok(cp.id);
 const fork=run(f.repo,'fork','alternative','--to',join(f.root,'alternative'),'--at',cp.id);
 assert.equal(run(fork.workspaceRoot,'inspect',fork.baseCheckpointId).research.evidence[0].id,'best');
 const imported=run(fork.workspaceRoot,'import',f.runtime.branchId,'best','--reason','A useful control'); assert.ok(imported.id);
 assert.equal(run(fork.workspaceRoot,'archive').lifecycle,'archived'); assert.equal(run(f.repo,'status','--branch',fork.branchId).lifecycle,'archived');
 assert.equal(run(f.repo,'restore',fork.branchId).lifecycle,'active'); assert.equal(run(f.repo,'doctor').issues.length,0);
 assert.equal(run(f.repo,'prune').dryRun,true);
});

test('doctor retains malformed metadata and repairs a missing catalog before pruning its stale binding',async t=>{
 const f=await fixture(t); const cp=await f.checkpoint();
 const fork=await forkResearchBranch(f.runtime,{name:'orphan',checkpointId:cp.id,to:join(f.root,'orphan')});
 const source=await resolveResearchRuntime(fork.workspaceRoot,{runtimeRoot:f.runtimeRoot});
 await rm(join(source.scopeDir,'branch.json')); await rm(source.workspaceRoot,{recursive:true,force:true});
 const applied=await pruneResearchBranches(f.runtime,{apply:true}); assert.ok(applied.repaired.some(i=>i.branchId===source.branchId));
 assert.equal((await selectResearchBranch(f.runtime,'orphan')).branchId,source.branchId);
 await writeFile(join(source.scopeDir,'branch.json'),'invalid json');
 const doctor=await doctorResearchBranches(f.runtime); assert.ok(doctor.issues.some(i=>i.code==='invalid_branch_metadata'));
});

test('a replacement directory at the same path cannot silently reuse another workspace identity',async t=>{
 const f=await fixture(t); const cp=await f.checkpoint();
 const fork=await forkResearchBranch(f.runtime,{name:'replaceable',checkpointId:cp.id,to:join(f.root,'replaceable')});
 // Keep the old inode allocated so the fixture also works on inode-reusing filesystems.
 const {rename}=await import('node:fs/promises'); await rename(fork.workspaceRoot,join(f.root,'old-directory'));
 await mkdir(fork.workspaceRoot); git(fork.workspaceRoot,'init','-b','unrelated');
 await assert.rejects(resolveResearchRuntime(fork.workspaceRoot,{runtimeRoot:f.runtimeRoot}),/directory was replaced/);
 const report=await doctorResearchBranches(f.runtime); assert.ok(report.issues.some(i=>i.code==='binding_corrupt'&&i.branchId===fork.branchId));
 assert.equal((await pruneResearchBranches(f.runtime,{apply:true})).repaired.length,0);
});

test('Leader checkpoint and evidence adoption tools use Runtime history; Analysis history remains read-only',async t=>{
 const f=await fixture(t); await f.evidence('best');
 const prior=process.env.RESEARCH_PI_RUNTIME_DIR; process.env.RESEARCH_PI_RUNTIME_DIR=f.runtimeRoot;
 t.after(()=>{if(prior===undefined)delete process.env.RESEARCH_PI_RUNTIME_DIR;else process.env.RESEARCH_PI_RUNTIME_DIR=prior;});
 const tools=new Map(), entries=[];
 const api={registerTool:tool=>tools.set(tool.name,tool),appendEntry:(...value)=>entries.push(value)};
 const {default:checkpoints}=await import('../.pi/extensions/research-checkpoint.ts'); checkpoints(api);
 const ctx={cwd:f.repo,sessionManager:{getSessionId:()=> 'leader',getLeafId:()=> 'context-entry',getSessionFile:()=> undefined}};
 const cp=(await tools.get('research_checkpoint').execute('call',{label:'tool checkpoint',rationale:'Preserve the comparison'},undefined,undefined,ctx)).details;
 assert.ok(cp.checkpointId); assert.equal((await readRuntimeSnapshot(f.runtime)).checkpoints.length,1);
 const fork=await forkResearchBranch(f.runtime,{name:'tool-target',checkpointId:cp.checkpointId,to:join(f.root,'tool-target')});
 await initializeResearchRuntime(fork.workspaceRoot,{sessionId:'target-leader'},{runtimeRoot:f.runtimeRoot});
 const {default:branches}=await import('../.pi/extensions/research-branches.ts'); branches(api);
 const targetCtx={cwd:fork.workspaceRoot,sessionManager:{getSessionId:()=> 'target-leader'}};
 const imported=await tools.get('import_research_evidence').execute('adopt',{branch:f.runtime.branchId,evidenceId:'best',reason:'Relevant mechanism evidence'},undefined,undefined,targetCtx);
 assert.ok(imported.details.id);
 const before=await readFile(f.runtime.ledgerPath,'utf8');
 const history=await tools.get('research_branch_history').execute('history',{branch:f.runtime.branchId},undefined,undefined,targetCtx);
 assert.equal(history.details.checkpoints.length,1); assert.equal(await readFile(f.runtime.ledgerPath,'utf8'),before);
 const {analysisSessionToolBlockReason}=await import('../.pi/extensions/research-runtime.ts');
 assert.equal(analysisSessionToolBlockReason('analysis','research_branch_history'),null);
 assert.match(analysisSessionToolBlockReason('analysis','import_research_evidence'),/cannot use/);
});
