import { runtimePerformance } from '../lib/runtime-performance.mjs';
import { getSubagentRuntimeAdapter } from '../lib/research-runtime-adapters.mjs';

// Explicitly enabled, in-memory monitoring. CPU/RSS cover the entire process,
// not just the harness; journal counters cover instrumented display logs only.
export default function performanceExtension(pi) {
 let timer, context;
 const mb = n => (n / 1048576).toFixed(1);
 const describe = s => !s?.enabled ? 'off' : s.warmingUp ? 'warming up (2 seconds)' :
  `PID ${s.pid} · CPU ${s.cpuPercent.toFixed(1)}% · RSS ${mb(s.rssBytes)} MiB · loop p99 ${s.eventLoopP99Ms?.toFixed(1) ?? 'unknown'} ms`;
 const report = async () => {
  const current = runtimePerformance.snapshot();
  const lines = [describe(current), 'Scope: CPU/RSS = whole process; writes = display journal only; no disk sampling or automatic log files.'];
  if (current.rates) for (const [key, rate] of Object.entries(current.rates)) lines.push(`${key}: ${rate.toFixed(1)}/s (total ${current.counters[key]})`);
  const adapter = getSubagentRuntimeAdapter('pi');
  for (const job of await adapter?.list?.() ?? []) if (job.performance?.enabled) {
   const sample = job.performance;
   lines.push(`${job.mission ?? job.id}: ${describe(sample)} · sample age ${sample.timestamp ? ((Date.now()-sample.timestamp)/1000).toFixed(1)+'s' : 'unknown'}`);
   if (sample.rates) lines.push(Object.entries(sample.rates).map(([k,v]) => `${k} ${Number(v).toFixed(1)}/s`).join(' · '));
  }
  context?.ui.notify(lines.join('\n'), 'info');
 };
 pi.registerCommand('perf', { description: 'Performance monitor: /perf on | off | status (memory only)', handler: async (args,ctx) => {
  context = ctx;
  const command = args.trim() || 'status';
  if (!['on','off','status'].includes(command)) { ctx.ui.notify('Usage: /perf on | off | status', 'warning'); return; }
  if (command !== 'status') {
   runtimePerformance.setEnabled(command === 'on'); clearInterval(timer);
   if (command === 'on') { timer = setInterval(() => ctx.ui.setStatus('performance', describe(runtimePerformance.snapshot())), 2000); timer.unref(); }
   else ctx.ui.setStatus('performance', undefined);
  }
  await report();
 }});
 pi.on('session_shutdown', async () => { clearInterval(timer); runtimePerformance.setEnabled(false); });
}
