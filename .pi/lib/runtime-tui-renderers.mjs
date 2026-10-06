import { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { ToolExecutionComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js';
import { FooterComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
import { allToolNames, createToolDefinition } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js';
import { createSubagentToolRenderers } from '../extensions/codex-delegate.ts';

const text = (message) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export class RuntimeTranscript {
  constructor(tui) { this.tui = tui; this.components = new Map(); }
  invalidate() { for (const c of this.components.values()) c.invalidate?.(); }
  clear() { this.components.clear(); }
  render(entries, state, width, hiddenThinking = false) {
    const next = new Map(), tools = new Map(), results = new Map(), rows = [];
    for (const entry of entries) if (entry.message?.role === 'toolResult') results.set(entry.message.toolCallId, entry.message);
    const render = (key, create) => { const c = this.components.get(key) ?? create(); next.set(key, c); rows.push(...c.render(width)); return c; };
    const tool = (call) => {
      if (tools.has(call.id)) return;
      tools.set(call.id, call);
      const definition = call.name === 'subagent' || call.name === 'demo_subagent' ? createSubagentToolRenderers() : allToolNames.has(call.name) ? createToolDefinition(call.name, state.cwd) : undefined;
      const c = this.components.get('tool:' + call.id) ?? new ToolExecutionComponent(call.name, call.id, call.arguments, {}, definition, this.tui, state.cwd);
      c.updateArgs(call.arguments); c.setArgsComplete(); c.markExecutionStarted(); c.setExpanded(Boolean(state.toolsExpanded));
      const result = results.get(call.id) ?? state.liveTools?.find(t => t.id === call.id)?.result;
      if (result) c.updateResult({ ...result, isError: result.isError === true }, !results.has(call.id));
      next.set('tool:' + call.id, c); rows.push(...c.render(width));
    };
    for (const entry of entries) {
      const m = entry.message ?? { role: 'custom', content: entry.content };
      if (m.role === 'toolResult') {
        if (!tools.has(m.toolCallId)) tool({ id: m.toolCallId, name: m.toolName, arguments: {} });
        continue;
      }
      if (m.role === 'assistant') {
        const c = this.components.get(entry.id) ?? new AssistantMessageComponent(m, hiddenThinking);
        c.setHideThinkingBlock(hiddenThinking); c.updateContent(m); next.set(entry.id, c); rows.push(...c.render(width));
        for (const call of m.content ?? []) if (call.type === 'toolCall') tool(call);
      } else render(entry.id, () => m.role === 'user' ? new UserMessageComponent(text(m)) : new Markdown(text(m), 1, 0, getMarkdownTheme()));
      rows.push('');
    }
    if (state.activeMessage) {
      rows.push(...new AssistantMessageComponent(state.activeMessage, hiddenThinking).render(width));
      for (const call of state.activeMessage.content ?? []) if (call.type === 'toolCall') tool(call);
    }
    this.components = next; return rows;
  }
}

// Native Footer layout over a read-only Host projection; no AgentSession is created.
export class RuntimeFooter extends FooterComponent {
  constructor(readState, footerData) {
    const session = {
      get state() { const s = readState(); return { model: s.model, thinkingLevel: s.thinking }; },
      sessionManager: { getCwd: () => readState().cwd, getSessionName: () => readState().sessionName },
      modelRuntime: { isUsingSubscription: () => readState().footer?.subscription === true },
    };
    super(session, footerData); this.readState = readState;
  }
  getSessionStats() {
    const s = this.readState(), latest = [...(s.entries ?? [])].reverse().find(e => e.message?.role === 'assistant' && e.message.usage)?.message.usage;
    const prompt = latest ? latest.input + latest.cacheRead + latest.cacheWrite : 0;
    return { usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...s.stats?.tokens, cost: s.stats?.cost ?? 0 }, contextUsage: s.usage, latestCacheHitRate: prompt ? latest.cacheRead / prompt * 100 : undefined };
  }
  render(width) { this.setAutoCompactEnabled(this.readState().footer?.autoCompactEnabled ?? true); return super.render(width); }
}
