import { chmod, unlink } from 'node:fs/promises';
import { InteractiveMode } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js';
import { NativeTerminal } from './native-terminal.mjs';
import { createDesktopTerminal } from './web-terminal.mjs';

export async function createNativeRuntimeHost({ runtime, terminalSocket, instance, tuiMode = runtime.startupTuiMode ?? "fullscreen", onShutdown = async()=>{} }) {
  let desktop, closing = false, inputSocket;
  const terminal = new NativeTerminal({output: event => desktop?.broadcast(event)});
  const mode = new InteractiveMode(runtime, { terminal, tuiMode,
    startupDiagnostics: runtime.diagnostics, initialThemeSetting: runtime.services.settingsManager.getTheme(),
    initialMessage: runtime.startupInput?.initialMessage, initialImages: runtime.startupInput?.initialImages,
    initialMessages: runtime.startupMessages,
  });
  const state = () => ({ready: !closing && mode.isInitialized, cwd: runtime.cwd, sessionId:runtime.session.sessionId,
    idle:runtime.session.isIdle, model:runtime.session.model && {id:runtime.session.model.id,provider:runtime.session.model.provider}});
  // Native quit is a presentation detach. Runtime disposal is only explicit stop.
  const nativeShutdown = mode.shutdown.bind(mode);
  mode.shutdown = async options => {
    if (options?.fromSignal) return close();
    mode.shutdownRequested = false; mode.isShuttingDown = false; desktop?.detach();
  };
  desktop = await createDesktopTerminal({path:terminalSocket,instance,
    terminal:{write:(data,socket)=>{inputSocket=socket;terminal.input(data)},resize:(c,r)=>terminal.resize(c,r),capabilities:({kitty})=>{terminal.kittyProtocolActive=kitty},snapshot:()=>terminal.snapshot()},state,stop:()=>void close()});
  const externalEdit = async (editor, command) => {
    const epoch = runtime.session.sessionId, revision = editor.getText();
    try { const result = await desktop.requestAction(inputSocket, 'external-editor', { command, content: editor.getExpandedText?.() ?? revision });
      if (result?.status === 'complete' && epoch === runtime.session.sessionId && editor.getText() === revision) editor.setText(result.content);
    } catch(error) { mode.showError(error.message); } finally { mode.ui.requestRender(true); }
  };
  mode.handleOpenExternalEditor = () => externalEdit(mode.editor, mode.settingsManager.getExternalEditorCommand());
  mode.handleCtrlZ = () => { void desktop.requestAction(inputSocket,'suspend').catch(e=>mode.showError(e.message)); };
  const showEditor = mode.showExtensionEditor.bind(mode);
  mode.showExtensionEditor = (...args) => { const pending = showEditor(...args), view = mode.extensionEditor; if (view) view.handleOpenExternalEditor = () => externalEdit(view.editor, view.externalEditorCommand); return pending; };
  await chmod(terminalSocket,0o600);
  const ready = mode.init();
  await ready;
  // Original input/command loop: no replicated slash parser or substitute editor.
  const run = mode.run().catch(error=>{if (!closing) { console.error('Native presentation: '+error.message);void close();}});
  if (runtime.startupResume) void mode.defaultEditor.onSubmit("/resume");
  async function close() {
    if (closing) return; closing = true;
    mode.shutdown = nativeShutdown; mode.stop();
    await runtime.dispose(); await desktop.close(); terminal.dispose();
    await unlink(terminalSocket).catch(e=>{if(e.code!=='ENOENT')throw e});await onShutdown();
  }
  return {runtime,mode,terminal,state,close,run};
}
