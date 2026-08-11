# Research Pi on Windows through WSL2

Research Pi 在 Windows 上的推荐入口是 WSL2。Agent、项目文件、Node、Git、Codex 和实验工具都运行在 Linux 环境内；PowerShell 只负责安装或进入 WSL，不解释模型生成的命令。

## 安全边界

`windows-research-pi` 分支增加以下启动不变量：

- 只支持 WSL2，拒绝 WSL1；
- Research Pi 与目标科研项目必须位于 WSL 文件系统，例如 `/home/user/research/project`；
- 拒绝把 `/mnt/c`、`/mnt/d` 等 Windows host mount 作为 workspace；
- agent shell 无权读取或写入 `/mnt`、`/run/WSL` 和常见 host mount bridge；
- agent shell 与 Codex worker 不继承 `WSL_INTEROP` / `WSLENV`，并从 `PATH` 删除 `/mnt` 和 host-mount executable；
- 必须启用 bubblewrap 和 seccomp；缺少 Unix socket restriction 时 fail closed；
- 启动后在沙箱内运行一次无副作用的 `cmd.exe /d /c exit 0` 探针；如果 Windows host interop 成功，整个 agent shell 被禁用；
- direct file tools 请求 `/mnt` 等项目外路径时仍需要一次明确人工批准，非交互模式拒绝；
- 项目认可的精确 SSH target 可持久信任；通用 host command 与 project script 只能 one-shot 批准，旧 session/project command grant 不会生效；
- host-command 的 PATH 会移除 Windows mount，且拒绝明显的 `/mnt`、Windows `.exe`、PowerShell/cmd/wsl/explorer 入口；
- 用户输入的 `!` / `!!` 是人工直执行通道，不受 agent sandbox 保护。

阻断 Unix socket 很重要：WSL 可以通过 interop 把 Windows `.exe` 交给宿主执行。仅仅隐藏 `/mnt/c` 不足以替代 seccomp；Research Pi 同时要求文件边界、socket 边界和启动探针。

## 1. 安装 WSL2

在管理员 PowerShell 中执行：

```powershell
wsl --install -d Ubuntu
wsl --update
```

重启 Windows 后进入 Ubuntu，确认版本：

```sh
uname -a
printf '%s\n' "$WSL_DISTRO_NAME"
```

从 PowerShell 也可查看：

```powershell
wsl --list --verbose
```

目标 distribution 的 `VERSION` 必须是 `2`。

## 2. 安装 Linux 依赖

在 WSL 内执行：

```sh
sudo apt update
sudo apt install -y git zsh ripgrep fd-find bubblewrap socat
```

安装 Linux 版 Node.js `>=22.19`，随后确认所有命令来自 WSL，而不是 `/mnt/c`：

```sh
node --version
npm --version
git --version
zsh --version
command -v node npm git zsh rg fdfind bwrap socat
```

关键工具建议安装在 `/usr/bin`、`/usr/local/bin` 或其他 Linux 路径。不要依赖 Windows Node、Windows Git 或位于 `/mnt/c` 的 executable。

Pi 0.84.1 会把 Ubuntu 的 `fdfind` 识别为 `fd`，因此不需要下载 GitHub release，也不需要创建不受包管理器维护的手工副本。这同时避免 GitHub API 限流导致的 `fd not found ... 403` 启动提示。

## 3. 克隆 Research Pi

仓库必须位于 WSL home：

```sh
mkdir -p ~/research
cd ~/research
git clone --branch windows-research-pi git@github.com:RosMarinas/Research-Pi.git
cd Research-Pi
npm install --ignore-scripts
cp .env.example .env
```

编辑 `.env`，填入：

```dotenv
DEEPSEEK_API_KEY=你的_API_key
```

`.env` 留在 WSL 文件系统中，并已被 Git 忽略。Agent child environment 不继承该 API key。

## 4. 安装命令入口

```sh
./install-user.sh
```

确认 `~/.local/bin` 在 `PATH`，随后重新打开 WSL shell，或执行：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Codex delegation 需要在 WSL 内单独安装 Linux Codex CLI 并完成登录。不要让 Research Pi 调用 Windows 侧的 `codex.exe`。

## 5. 放置科研项目

正确：

```sh
mkdir -p ~/research/projects
cd ~/research/projects
git clone <your-project-url>
cd <your-project>
pi
```

拒绝：

```text
/mnt/c/Users/you/project
/mnt/d/experiments/project
```

Windows 可以通过 `\\wsl$\Ubuntu\home\...` 浏览 WSL 文件，但不要把 Windows 编辑器配置成对整个 WSL home 做自动同步、清理或杀毒重写。

## 6. 检查边界

先在普通 WSL shell 中运行无模型 doctor：

```sh
pi doctor --workspace "$PWD"
```

除 Git、Python 和 Codex preflight 外，应出现 `WSL2 boundary: research-pi-wsl-preflight=ok`。该检查会验证 bubblewrap/seccomp 依赖，并确认 sandbox 内既不能读取 `/mnt/c`，也不能运行 `cmd.exe`。

成功启动后，状态栏应显示类似：

```text
🔒 wsl2 · project-only · host bridge blocked
```

在 Pi 中运行：

```text
/boundary
```

应看到：

- project root 在 `/home/...`；
- `/mnt` denied；
- seccomp required；
- `cmd.exe` host-interop probe blocked。

如果状态是 `boundary failed closed`，不要通过关闭 sandbox 解决。根据错误补齐 `bwrap`、`socat`、`rg`，升级到 WSL2，或把项目移出 `/mnt`。

## SSH 与远程实验授权

科研服务器使用 Linux SSH broker，不需要开放 WSL host interop。可在 Pi 中一次性建立当前项目的精确 target 信任：

```text
/boundary trust-ssh 931server
/boundary grants
```

此后 Pi 和 Codex executor 可自动向该 target 运行不同远程命令，SSH config、key 和 agent 内容仍不会进入模型。若项目的 `remote_run.py` 必须在 sandbox 外使用本地 SSH，则每次由工具弹窗选择 `Approve once`，或先执行：

```text
/boundary grant-command uv run remote_run.py <本次精确参数>
```

在 WSL2 中这条 grant 只可消费一次；`/boundary trust-command` 被拒绝。优先让 agent 使用 `ssh-target`，因为它只暴露远程命令能力，不会让任意项目代码获得整个 WSL 用户权限。

## Windows 原生操作

需要 Windows Registry、Windows service、MSVC GUI 或其他宿主能力时，由 Pi 给出精确命令，再由用户在 PowerShell 人工执行。不要从 agent shell 内调用：

```text
powershell.exe
pwsh.exe
cmd.exe
wsl.exe
explorer.exe
/mnt/c/.../*.exe
```

未来如需自动化这些能力，应增加独立的结构化 Windows tool 和单次人工授权；不应给 Linux shell 或通用 host-command 打开 WSL interop。

## 本地验证

在 Research Pi 仓库运行：

```sh
npm run check
npm test
```

当前 macOS/Linux 单元测试验证配置和 fail-closed 判断；真正的 WSL host-interop、bubblewrap、seccomp、长任务取消和 Codex delegate 仍应在 Windows 11 WSL2 实机上完成 smoke test 后，才能把该分支标为稳定 Windows 支持。
