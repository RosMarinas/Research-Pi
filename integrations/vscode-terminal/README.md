# Research Pi Terminal

Opens Research Pi subagent conversations in the IDE window where the user requests them, including VS Code, Antigravity and compatible editors. It splits beside the originating terminal when its shell PID can be identified. Otherwise, an authenticated window-local request opens a new terminal in that window's panel.

In Pi, use `/watch` and choose **Open a new terminal**. Pi discovers the window by the requesting process's terminal ancestry, including terminals created before extension installation and terminals with an expired bridge address. When the bridge is missing, Pi uses the originating IDE's CLI to install it. It does not use a global `code` command, which might target a different application. Automatic packaging needs Python 3. If the IDE requires extension activation or a window reload, Pi reports that without reloading the window or stopping running work.

The bridge is local to the IDE extension host and updates a private temporary registration on terminal open/close events. It does not poll or write logs. It uses `createTerminal` with a Node executable and argument array, not shell `sendText`. No keyboard simulation, changes to `.vscode/tasks.json`, or global default-terminal changes are used. Remote SSH/WSL requires installation in that remote extension host and has not been validated in this release. Automatic CLI discovery is implemented for macOS and Linux; Windows can use an installed bridge.

If automatic setup is unavailable, install the VSIX in the IDE you are using through **Extensions: Install from VSIX**. Pi also provides a watch command to paste into another terminal in that IDE. A Leader inside tmux retains tmux's new-window behavior. **Switch in this terminal** continues to work without this extension.

Build from Research Pi, then install the result in the intended IDE:

```sh
python3 scripts/package-vscode-terminal.py
code --install-extension output/research-pi-terminal.vsix
```

The `code` example is for VS Code. Use the selected IDE's own CLI or its **Install from VSIX** action for Antigravity and other editors.

Uses VS Code's documented terminal API: https://code.visualstudio.com/api/references/vscode-api#TerminalOptions
