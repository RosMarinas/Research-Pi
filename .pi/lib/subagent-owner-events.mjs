// The owner needs deltas and lifecycle, never a cumulative assistant snapshot
// per token. Full conversation state remains in the owning native session.
export function projectOwnerEvent(event) {
 if (event.type === 'message_update') {
  const update = event.assistantMessageEvent;
  if (!['text_delta', 'thinking_delta'].includes(update?.type)) return null;
  return { type: event.type, assistantMessageEvent: { type: update.type, delta: update.delta } };
 }
 if (event.type === 'message_end') {
  if (event.message?.role !== 'assistant') return null;
  const { role, content, stopReason, errorMessage, model } = event.message;
  return { type: event.type, message: { role, content: content.filter(c => c.type === 'text'), stopReason, errorMessage, model } };
 }
 if (['agent_start', 'agent_settled'].includes(event.type)) return { type: event.type };
 if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) return event;
 return null;
}

// Tool output is a replaceable snapshot. Keep only the newest snapshot per
// call in a 100ms window; lifecycle boundaries flush pending updates in order.
export function createOwnerEventWriter(send) {
 const pending = new Map(); let timer;
 const flush = () => {
  clearTimeout(timer); timer = undefined;
  for (const event of pending.values()) send(event);
  pending.clear();
 };
 return {
  append(event) {
   const projected = projectOwnerEvent(event); if (!projected) return;
   if (event.type === 'tool_execution_update' && event.toolCallId) {
    pending.set(event.toolCallId, projected);
    if (!timer) { timer = setTimeout(flush, 100); timer.unref(); }
   } else {
    if (event.type === 'tool_execution_end') pending.delete(event.toolCallId);
    flush(); send(projected);
   }
  }, flush,
 };
}
