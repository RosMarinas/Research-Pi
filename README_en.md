# Research Pi

[简体中文](README.md) · English

Research Pi helps with research: reading code, designing and running experiments, and interpreting results. It can also assign independent tasks to other models. Goals, decisions, and experiment records stay with the project, so a new session does not have to start from scratch.

**This branch runs directly on Windows with PowerShell. WSL is not required.**

| Environment | Branch |
| --- | --- |
| Windows + PowerShell | `windows-powershell-research-pi` (this branch) |
| Windows + WSL2 | `windows-wsl-research-pi` |
| Linux / macOS | `main` |

## Install and start

Install **PowerShell 7.6+, Node.js 22.19+, and Git**. Open PowerShell 7, rather than the built-in Windows PowerShell 5.1.

```powershell
git clone -b windows-powershell-research-pi https://github.com/RosMarinas/Research-Pi.git
Set-Location Research-Pi
npm.cmd ci
```

Install the command sandbox once. Windows will ask for permission:

```powershell
node .\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install
npm.cmd run test:windows
```

After the check passes, create the configuration and open your research project. Replace the example path with your project directory:

```powershell
node .\bin\pi.mjs setup
node .\bin\pi.mjs --workspace 'C:\Research\My Project'
```

Run these commands from the Research Pi checkout. This explicit launcher also avoids confusion with another installed command named `pi`.

## Connect a model

Inside Pi, use `/login` to sign in to a supported service, then `/model` to choose a model.

For an API key, run:

```powershell
node .\bin\pi.mjs paths
```

Open the file shown as `credentialsPath` and fill in only the providers you use:

```dotenv
DEEPSEEK_API_KEY=your-key
OPENCODE_API_KEY=your-key
ZAI_API_KEY=your-key
```

Exit and restart Pi after changing a key. Do not paste keys into chat or commit them to Git. See [configuration](docs/configuration.md) for more options.

## Use it

Describe your research question directly. For example:

> Read the existing code and experiment records. Explain why training has not improved, identify the most useful cause to test, and propose a simple controlled experiment.

| Command | Purpose |
| --- | --- |
| `/model` | Choose the current model |
| `/models` | Configure other models and their roles |
| `/actors` | See the assistants working on the project |
| `/watch` | View another assistant's work |

One model is enough to get started. Add Codex or Antigravity when you need parallel work. **Codex requires its own CLI installation and `codex login`; signing in through Pi does not sign in to Codex.**

## Current limits

This is a native Windows preview. Offline regression checks have passed; terminal behavior, permissions, and model interactions still need testing on Windows.

Foreground terminal sessions and workers are the initial scope. **Resident background sessions, continuing after closing the terminal, and Web access are not supported yet.** Use the WSL2 branch for those features. The sandbox dependency's Windows support is also still alpha.

When reporting a problem, include the failing command, error output, and Windows, PowerShell, and Node versions. Do not disable permission checks to hide a failure.

- [Windows installation, testing, and troubleshooting](docs/windows-powershell-guide.md)
- [Models and configuration](docs/configuration.md)
- [Research prompt responsibilities](docs/research-prompt-contract.md)

## Update

End the current session, then run these commands from the checkout:

```powershell
git pull --ff-only
npm.cmd ci
```

Restart Pi. Windows adaptations stay on this branch without changing the Linux/macOS main branch.
