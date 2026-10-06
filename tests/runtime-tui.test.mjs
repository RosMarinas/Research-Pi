import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { RuntimeTranscript, RuntimeFooter } from '../.pi/lib/runtime-tui-renderers.mjs';
initTheme('dark', false);
const plain = rows => rows.map(stripTerminalSequences).join('\n');
const tui = { requestRender() {}, terminal: { columns: 100, rows: 40 } };
test('detached transcript pairs native calls/results and reuses original Subagent renderer', () => {
 const state = { cwd: '/tmp', toolsExpanded: false };
 const entries = [{id:'assistant',message:{role:'assistant',content:[{type:'toolCall',id:'t1',name:'subagent',arguments:{action:'resume',backend:'pi',role:'advisor',jobId:'abcdefghijkl',followUp:'Continue monitoring'}}]}},{id:'result',message:{role:'toolResult',toolCallId:'t1',toolName:'subagent',content:[{type:'text',text:'output'}],details:{id:'abcdefghijkl',backend:'pi',role:'advisor',mission:'monitor',model:'demo',thinking:'high',status:'running',progress:'bash running'}}}];
 const view = new RuntimeTranscript(tui); const rendered=view.render(entries,state,100);
 assert.equal((plain(rendered).match(/Subagent/g)||[]).length,1);assert.match(plain(rendered),/Subagent.*resume/);assert.match(plain(rendered),/pi advisor/);assert.match(plain(rendered),/bash running/);assert.ok(rendered.some(r=>r.includes('\x1b[48;')));
 state.toolsExpanded=true;assert.match(plain(view.render(entries,state,100)),/bash running/);
});
test('native built-in bash renderer preserves command and result',()=>{
 const rows=new RuntimeTranscript(tui).render([{id:'a',message:{role:'assistant',content:[{type:'toolCall',id:'bash-1',name:'bash',arguments:{command:'printf hello'}}]}},{id:'r',message:{role:'toolResult',toolCallId:'bash-1',toolName:'bash',content:[{type:'text',text:'hello'}],details:{},isError:false}}],{cwd:'/tmp'},100);
 assert.match(plain(rows),/printf hello/);assert.match(plain(rows),/hello/);
});
test('native footer retains cwd, cumulative stats, latest cache hit, model and statuses',()=>{
 const s={cwd:'/tmp/project',model:{id:'gpt-example',provider:'openai-codex',reasoning:true,contextWindow:512000},thinking:'high',stats:{tokens:{input:1000,output:500,cacheRead:9000},cost:1.25},usage:{contextWindow:512000,percent:25},footer:{subscription:true,autoCompactEnabled:true},entries:[{message:{role:'assistant',usage:{input:1000,cacheRead:9000,cacheWrite:0}}}]};
 const f=new RuntimeFooter(()=>s,{getGitBranch:()=> 'main',getAvailableProviderCount:()=>2,getExtensionStatuses:()=>new Map([['runtime','Runtime abc: idle']])});
 const output=plain(f.render(120));assert.match(output,/project \(main\)/);assert.match(output,/CH90.0%/);assert.match(output,/\$1.250 \(sub\)/);assert.match(output,/25.0%\/512k/);assert.match(output,/gpt-example.*high/);assert.match(output,/Runtime abc: idle/);
});
