import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {migrateLegacyResearchBranch} from '../.pi/lib/research-branch-migration.mjs';
import {resolveResearchRuntime,appendRuntimeEvent,claimRuntimeActorAttachment,detachRuntimeActor,readRuntimeSnapshot,upsertRuntimeAction,readRuntimeEvents} from '../.pi/lib/research-runtime.mjs';
import {extractSessionUnits} from '../.pi/lib/research-memory.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'pi-legacy-handoff-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo'),worktree=join(root,'worktree'),stateRoot=join(root,'state'),sessionDir=join(stateRoot,'sessions'),runtimeRoot=join(stateRoot,'runtime','projects');
 await mkdir(repo);git(repo,'init','-b','main');git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','baseline');git(repo,'worktree','add','-b','experiment',worktree);
 const runtime=await resolveResearchRuntime(worktree,{runtimeRoot});
 await appendRuntimeEvent(runtime,'actor.registered',{id:'research-leader',kind:'leader'});
 await appendRuntimeEvent(runtime,'actor.registered',{id:'pi:old',kind:'subagent',backend:'pi'});
 await appendRuntimeEvent(runtime,'project.state.committed',{state:{researchQuestion:'preserved research'},source:{sessionId:'original'}});
 await appendRuntimeEvent(runtime,'evidence.recorded',{id:'exp-old',question:'an observation',observation:'observed result',intervention:'change',conclusion:'limited finding'});
 const manager=SessionManager.create(worktree,sessionDir);manager.appendMessage({role:'user',content:[{type:'text',text:'Continue the actual latest task'}],timestamp:Date.now()});
 manager.appendCustomEntry('research-runtime-branch',{projectKey:runtime.projectKey,branchId:null,workspaceKey:runtime.workspaceKey});
 const mainSession=SessionManager.create(repo,sessionDir);mainSession.appendMessage({role:'user',content:[{type:'text',text:'Discard this main context'}],timestamp:Date.now()});
 const input={cwd:worktree,stateRoot,sessionDir,runtimeRoot,name:'continuous_training',freshWorkspace:repo,freshName:'main',sessionId:manager.getSessionId(),handoff:'Keep current work; main is independent.'};
 return {root,repo,worktree,stateRoot,sessionDir,runtimeRoot,runtime,manager,mainSession,input};
}

test('offline migration preserves original Session/history and makes the sibling empty and independent',async t=>{
 const f=await fixture(t);const source=await readFile(f.runtime.ledgerPath,'utf8'),sessionBefore=await readFile(f.manager.getSessionFile(),'utf8'),mainBefore=await readFile(f.mainSession.getSessionFile(),'utf8');
 const preview=await migrateLegacyResearchBranch(f.input);assert.equal(preview.dryRun,true);assert.equal(await readFile(f.manager.getSessionFile(),'utf8'),sessionBefore);
 const result=await migrateLegacyResearchBranch({...f.input,apply:true});assert.equal(result.status,'complete');
 const kept=await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot}),fresh=await resolveResearchRuntime(f.repo,{runtimeRoot:f.runtimeRoot});
 assert.notEqual(kept.branchId,fresh.branchId);assert.equal(kept.projectKey,fresh.projectKey);
 const s=await readRuntimeSnapshot(kept);assert.equal(s.projectState.state.researchQuestion,'preserved research');assert.equal(s.evidence.length,1);assert.equal(s.attachments.length,0);assert.ok(s.actors.find(a=>a.id==='pi:old').retiredAt);assert.equal(s.checkpoints.length,1);
 assert.equal((await readRuntimeSnapshot(fresh)).revision,0);assert.equal((await readRuntimeEvents(fresh)).length,0);
 assert.equal(await readFile(f.runtime.ledgerPath,'utf8'),source);assert.equal(await readFile(join(result.backupDir,'legacy.events.jsonl'),'utf8'),source);
 assert.ok((await readFile(f.manager.getSessionFile(),'utf8')).startsWith(sessionBefore));assert.equal(await readFile(f.mainSession.getSessionFile(),'utf8'),mainBefore);
 const units=extractSessionUnits(f.manager.getSessionFile());assert.equal(units.units[0].branchId,kept.branchId);
 const legacy=await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot,scope:{projectKey:kept.projectKey,branchId:null}});assert.equal(legacy.legacySealed,true);await assert.rejects(appendRuntimeEvent(legacy,'note',{}),/migrated/);
 assert.equal((await migrateLegacyResearchBranch({...f.input,apply:true})).unchanged,true);
});

test('migration refuses active tasks, attached Leader and live Native Hosts',async t=>{
 const f=await fixture(t);await claimRuntimeActorAttachment(f.runtime,'research-leader',{sessionId:'original'});
 await assert.rejects(migrateLegacyResearchBranch({...f.input,apply:true}),/attached Sessions/);await detachRuntimeActor(f.runtime,'research-leader','original');
 await upsertRuntimeAction(f.runtime,{id:'active-job',status:'running'});await assert.rejects(migrateLegacyResearchBranch({...f.input,apply:true}),/active or unresolved/);await upsertRuntimeAction(f.runtime,{id:'active-job',status:'completed'});
 const host=join(f.stateRoot,'native-hosts','test');await mkdir(host,{recursive:true});await writeFile(join(host,'access.json'),JSON.stringify({pid:process.pid,cwd:f.worktree}));
 await assert.rejects(migrateLegacyResearchBranch({...f.input,apply:true}),/still alive/);
});

test('migration rejects another project or a foreign Session before publishing bindings',async t=>{
 const f=await fixture(t);await assert.rejects(migrateLegacyResearchBranch({...f.input,sessionId:f.mainSession.getSessionId(),apply:true}),/does not belong/);
 const other=join(f.root,'unrelated');await mkdir(other);git(other,'init','-b','main');await assert.rejects(migrateLegacyResearchBranch({...f.input,freshWorkspace:other,apply:true}),/same project/);
 assert.equal((await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot})).branchId,null);
});

test('the original worktree Session can resume under its migrated binding while old main history is rejected',async t=>{
 const f=await fixture(t);await migrateLegacyResearchBranch({...f.input,apply:true});
 const prior=process.env.RESEARCH_PI_RUNTIME_DIR;process.env.RESEARCH_PI_RUNTIME_DIR=f.runtimeRoot;t.after(()=>{if(prior===undefined)delete process.env.RESEARCH_PI_RUNTIME_DIR;else process.env.RESEARCH_PI_RUNTIME_DIR=prior;});
 const {default:extension}=await import('../.pi/extensions/research-runtime.ts');
 const setup=manager=>{const handlers=new Map();extension({on:(n,h)=>handlers.set(n,h),registerTool(){},registerCommand(){},registerMessageRenderer(){},registerEntryRenderer(){},appendEntry:(type,data)=>manager.appendCustomEntry(type,data)});return handlers;};
 const manager=SessionManager.open(f.manager.getSessionFile(),f.sessionDir);const handlers=setup(manager);
 const ctx={cwd:f.worktree,hasUI:false,isIdle:()=>true,sessionManager:manager};
 await handlers.get('session_start')({reason:'resume'},ctx);const runtime=await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot});assert.equal((await readRuntimeSnapshot(runtime)).attachments[0].sessionId,manager.getSessionId());
 await handlers.get('session_shutdown')({},ctx);
 const oldMain=SessionManager.open(f.mainSession.getSessionFile(),f.sessionDir);const oldHandlers=setup(oldMain);await assert.rejects(oldHandlers.get('session_start')({reason:'resume'},{...ctx,cwd:f.repo,sessionManager:oldMain}),/no research branch binding/);
});

test('matching canonical experiment fingerprints are retained for idempotent retries',async t=>{
 const f=await fixture(t);const dir=join(f.worktree,'.pi','research');await mkdir(dir,{recursive:true});await writeFile(join(dir,'experiments.jsonl'),JSON.stringify({id:'exp-old',question:'an observation',observation:'observed result',intervention:'change',conclusion:'limited finding',contentFingerprint:'original-fingerprint',sessionId:f.manager.getSessionId()})+'\n');
 await migrateLegacyResearchBranch({...f.input,apply:true});const r=await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot});assert.equal((await readRuntimeSnapshot(r)).evidence[0].contentFingerprint,'original-fingerprint');
});

test('other Analysis transcripts stay untouched and their explicit migration map restores branch memory',async t=>{
 const f=await fixture(t);const analysis=SessionManager.create(f.worktree,f.sessionDir);analysis.appendMessage({role:'user',content:[{type:'text',text:'historical analysis marker'}],timestamp:Date.now()});analysis.appendCustomEntry('research-runtime-session-policy',{policy:'analysis',projectContext:'project'});
 const before=await readFile(analysis.getSessionFile(),'utf8');await migrateLegacyResearchBranch({...f.input,apply:true});assert.equal(await readFile(analysis.getSessionFile(),'utf8'),before);
 const runtime=await resolveResearchRuntime(f.worktree,{runtimeRoot:f.runtimeRoot}),snapshot=await readRuntimeSnapshot(runtime);
 const {openMemoryIndex,syncMemoryIndex,searchMemory}=await import('../.pi/lib/research-memory.mjs');const db=openMemoryIndex(join(f.root,'memory.sqlite'));t.after(()=>db.close());
 const scopes=Object.fromEntries(snapshot.legacyMigration.sessions.map(s=>[s.path,{sessionId:s.id,projectKey:runtime.projectKey,branchId:runtime.branchId,generation:0}]));
 syncMemoryIndex(db,{sessionDir:f.sessionDir,sessionScopes:scopes});assert.equal(searchMemory(db,{query:'historical analysis marker',currentCwd:f.worktree,currentProjectKey:runtime.projectKey,currentBranchId:runtime.branchId}).length,1);
});
