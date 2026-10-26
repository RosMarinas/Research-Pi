# Research Pi Terminal

Opens Research Pi subagent conversations in the same VS Code window as the Leader, splitting beside the Leader terminal when its shell PID can be identified. If the original terminal cannot be identified, the extension opens a new terminal in that window's panel.

After installation, create a **new integrated terminal** and start the Leader there so it inherits the window-local bridge address. In Pi, use `/watch` and choose **Open a new terminal**. Existing terminal sessions may need to be recreated; reloading Pi inside a terminal with an old bridge address is insufficient after a VS Code reload.

The bridge is local to the VS Code extension host, event-driven, and does not poll or write logs. It uses `createTerminal` with a Node executable and argument array, not shell `sendText`. No keyboard simulation, changes to `.vscode/tasks.json`, or global default-terminal changes are used. Remote SSH/WSL requires installation in that remote extension host and has not been validated in this release.

If the extension is absent, Pi explains the setup requirement and provides a command to paste into a new integrated terminal. It does not silently open macOS Terminal.app. A Leader inside tmux retains tmux's new-window behavior. **Switch in this terminal** continues to work without this extension.

Build and install from Research Pi:

```sh
python3 scripts/package-vscode-terminal.py
code --install-extension output/research-pi-terminal.vsix
```

Uses VS Code's documented terminal API: https://code.visualstudio.com/api/references/vscode-api#TerminalOptions
