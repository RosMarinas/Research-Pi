# Ghostty on Mac → SSH → Research Pi

Install once on the **Mac**, then keep using `ssh user@host` (including `-p`, `-i`, `-F`, `-J` and SSH host aliases). Inside Research Pi, `/watch` selects a subagent and opens a native **right split beside the requesting Ghostty pane**. The split connects to the same SSH destination and runs that actor's `pi watch` command with its exact remote workspace and state directory. `/watch --here` retains same-terminal switching.

This uses Ghostty's native AppleScript API and a private Unix socket forwarded through the existing encrypted SSH connection. It does not require tmux, a public/listening TCP port, `sshd` environment changes, GUI tools on Linux, a Mac SSH server, or a different everyday SSH command. The real SSH client still owns the terminal; no helper copies terminal input/output.

## Install on the Mac

You need Python 3, OpenSSH and Ghostty with AppleScript **terminal `tty` and `split` support** (the installer checks the installed dictionary; the existing Research Pi local adapter targets Ghostty 1.4). If Python is missing, install it with `brew install python`.

From a checkout of this branch on your Mac:

```sh
sh integrations/ghostty-ssh/install.sh
```

The installer checks Ghostty scripting, copies four small files into `~/Library/Application Support/Research Pi/ghostty-ssh`, backs up your shell startup file once, and adds a marked block at the end of `.zshrc` (or `.bash_profile`). No `sudo` is needed. It is safe to repeat. Allow the first macOS Automation request to control Ghostty; if previously denied, enable it in **System Settings → Privacy & Security → Automation**.

Open a **new Ghostty terminal** after installation, then:

```sh
ssh your-existing-host-alias
# On Linux, use the intended workspace as usual:
cd /path/to/your/worktree
pi
```

Choose an agent with `/watch`, or use `/watch pi:actor-...`. It opens on the right automatically. SSH authentication follows your existing host configuration; an agent/keychain-backed key makes the second connection hands-free. Password authentication can still prompt in the new split.

The installation does not replace third-party SSH aliases or remove previous custom automation. If an old custom `ssh` alias/function already opens windows or handles watch requests, disable **that old integration** first. Ghostty's standard SSH shell function is retained, including its normal terminfo setup. Put this source block after any custom definitions of `ssh`. `command ssh ...` explicitly bypasses shell integration.

## Rollout without interrupting a research task

Linux needs the matching Research Pi code. Updating an isolated checkout does not load it into existing clients or Hosts. At a convenient point, detach **only the terminal client** with `Ctrl+]`, reconnect using an integrated Mac `ssh`, and launch `pi` from the updated installation. The resident Host and its agents can continue running. The automatic `/watch` mode needs the updated Host UI; an older running Host can keep its **Open a new terminal** chooser and route the open request through the new physical client. Leave that Host running until its normal checkpoint.

## What is forwarded and what stays local

- Each SSH connection has its own token, private socket, immutable destination/connection arguments and source **Mac TTY**. A focus change or another Research Pi window cannot redirect the request.
- Only structured `open-watch` requests are accepted. Remote paths remain remote arguments; the Mac launches only the installed helper. A request cannot submit an arbitrary Mac shell command or AppleScript fragment.
- Remote node/launcher/workspace/state/actor fields come from the requesting runtime. No actor ID, project path or branch is hardcoded.
- Native split creation uses `every terminal whose tty ...`; it never guesses the current front window or generates keyboard events. New watch connections also get their own bridge, supporting further watch requests.
- A bounded cache deduplicates retransmitted request IDs. Opening the same agent again intentionally is allowed.
- A failed native launch reports its actual error and the original manual watch command. SSH/authentication failures after split creation remain visible in that split. A successful split response means **window creation**, not proof that SSH authentication or watch attachment completed.
- Local bridge processes exit after their SSH invocation finishes, or if their parent shell dies. Local launch files/sockets are removed. A small remote bootstrap removes its own socket when the remote command/login shell exits; an uncatchable remote kill can leave an inert uniquely named `/tmp/rpi-g-*.sock` entry.

The bridge is opt-in and gives a trusted remote Research Pi session permission to open Pi watch splits on this Mac. Socket directories are mode `0700`; plans and socket files are private to the user. Tokens and session records are never placed in repository files.

## SSH compatibility

The integration augments interactive login invocations only. Remote commands (`ssh host uptime`, Git/rsync), `ssh -G`, forwarding-only sessions (`-N`), background jobs (`-f`), `-T`, control commands and non-TTY calls retain their original behavior. An initial explicit `ssh host command` does not enable the watch bridge.

Interactive bridged connections use a dedicated nonmultiplexed SSH transport to bind socket lifetime to the actual client. Existing host aliases, identity/agent settings, user, port, `ProxyJump`, keepalives and configuration files are preserved. Explicit command-line `-L`, `-R` and `-D` forwards are kept for your original connection and omitted from additional watch connections to avoid rebinding ports. Avoid persistent `LocalForward`/`RemoteForward` entries in the host alias used for watch; SSH-config forwards otherwise apply to each new connection as OpenSSH normally does. Host aliases with `RemoteCommand`, `RequestTTY=no`, `SessionType=none` or forced background/stdin settings are not supported for bridged logins; use a regular interactive alias.

The server must allow **reverse streamlocal forwarding**. If SSH prints `remote port forwarding failed`, inspect the server's forwarding policy; the installer does not change it. This implementation deliberately fails the augmented connection if its private forward cannot be established, instead of leaving an apparently working but disconnected watch bridge. Use `RESEARCH_PI_GHOSTTY_DISABLE=1 ssh host` to temporarily use the ordinary connection.

Multi-hop `ProxyJump` from the Mac is supported. Starting a second unrelated `ssh` *inside* the remote shell does not forward the Mac bridge onward automatically. No private key is copied to Linux and no agent forwarding is added.

## Diagnose or uninstall

```sh
"$RESEARCH_PI_GHOSTTY_PYTHON" "$RESEARCH_PI_GHOSTTY_HOME/bridge.py" doctor
type ssh
```

On Linux, check `test -S "$RESEARCH_PI_GHOSTTY_SOCKET" && echo bridge-ready` in the new SSH login. Do not print the token. Runtime launch errors include the manual command; private local setup logs live only for the SSH invocation under `/tmp/rpi-g-*/bridge.log`.

To uninstall, run on the Mac:

```sh
sh "$HOME/Library/Application Support/Research Pi/ghostty-ssh/install.sh" uninstall
```

Open a fresh terminal afterward. Only the marked startup block and this integration's installed files are removed. Existing running SSH sessions are left alone.

## Validation and references

`node --test tests/ghostty-ssh.test.mjs` checks structured requests, authentication, request deduplication, source TTY selection, quoting, real Node/Python Unix socket transport, a disposable loopback OpenSSH reverse streamlocal tunnel, physical/nested client routing, failure fallbacks, installer repeatability and bash shell integration through a real PTY. Set `RESEARCH_PI_TEST_ZSH=/path/to/zsh` to include zsh. Mac GUI/Automation and live SSH authentication require final acceptance on a Mac; Linux tests cannot certify them.

The implementation follows the official [Ghostty AppleScript API](https://ghostty.org/docs/features/applescript), [Ghostty scripting dictionary](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef) and [OpenSSH forwarding/remote-command behavior](https://man.openbsd.org/ssh).
