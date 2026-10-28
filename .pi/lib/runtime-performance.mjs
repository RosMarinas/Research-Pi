import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

// Process-local counters only. No timers, histograms or disk writes when disabled.
export function createPerformanceMonitor() {
 let enabled = false, histogram, previous, latest, timer;
 const counters = Object.create(null), listeners = new Set();
 const clock = () => ({ at: performance.now(), cpu: process.cpuUsage(), counters: { ...counters } });
 const sample = () => {
  if (!enabled) return { enabled: false, pid: process.pid };
  const current = clock(), seconds = (current.at - previous.at) / 1000;
  const rates = Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, seconds > 0 ? (value - (previous.counters[key] ?? 0)) / seconds : 0]));
  latest = { enabled: true, pid: process.pid, timestamp: Date.now(), intervalSeconds: seconds,
   cpuPercent: seconds > 0 ? (current.cpu.user + current.cpu.system - previous.cpu.user - previous.cpu.system) / (seconds * 10000) : 0,
   rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed,
   eventLoopP99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
   counters: { ...counters }, rates };
  previous = current; histogram.reset(); return latest;
 };
 return {
  get enabled() { return enabled; },
  count(key, value = 1) { if (enabled) counters[key] = (counters[key] ?? 0) + value; },
  setEnabled(value) {
   if (enabled === value) return;
   enabled = value; clearInterval(timer); histogram?.disable(); latest = undefined;
   if (enabled) {
    for (const key of Object.keys(counters)) delete counters[key];
    previous = clock(); histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
    timer = setInterval(sample, 2000); timer.unref();
   }
   for (const listener of listeners) listener(enabled);
  },
  snapshot() { return latest ?? (enabled ? { enabled: true, pid: process.pid, warmingUp: true } : { enabled: false, pid: process.pid }); },
  sample,
  onToggle(listener) { listeners.add(listener); return () => listeners.delete(listener); },
 };
}
export const runtimePerformance = createPerformanceMonitor();
