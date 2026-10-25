# Research Pi 原生 Windows PowerShell 分支

分支：`windows-powershell-research-pi`。基线：main `773fd65`。
此分支不合回 main；Linux/macOS 主线继续保持原有平台范围。
WSL2 隔离分支改名为 `windows-wsl-research-pi`，不要用其禁止 Windows interop 的策略替代原生 Windows 策略。

## 当前实现范围

- 原生 Windows 前台 TUI、print/RPC、项目文件操作与 PowerShell 工具。
- 复用 main 的研究提示、账本缓存、邮箱与子代理逻辑。
- Pi worker 和 Codex/Antigravity 的原生程序/标准 npm Node shim 启动；不把模型参数拼入 cmd.exe。
- 项目边界使用现有 sandbox-runtime 的 Windows backend。该依赖将其标为 alpha；真实隔离仍须在本机验证。初始化失败时 agent shell 不降级为无沙箱执行。
- Windows 原生 resident host、Web/Tailscale、后台 detach 暂未开放；相应入口会明确报错。普通 `pi` 默认直接启动前台 Core，不探测 Unix socket/tmux。
- 关闭终端结束前台会话，不承诺持久驻留；需要持久驻留时继续使用 WSL 分支。

## 安装

在受支持的原生 Windows 上安装 PowerShell **7.6 LTS 最新补丁**、Git for Windows、Node（符合 package.json 的 >=22.19；建议使用仍受支持的 LTS）及所需 Python。使用 `pwsh.exe`，不是 Windows PowerShell 5.1 的 `powershell.exe`。不要从 WSL 或 Git Bash 执行本指南。

```powershell
$PSVersionTable.PSVersion
node --version
git --version

git clone --branch windows-powershell-research-pi https://github.com/RosMarinas/Research-Pi.git Research-Pi-PowerShell
Set-Location -LiteralPath .\Research-Pi-PowerShell
npm.cmd ci
```

Windows sandbox 需要一次机器安装。以下使用锁定在当前项目依赖中的 CLI，不下载另一个最新版；其安装程序会请求 UAC：

```powershell
node .\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install
```

安装后运行离线检查；`test:windows` 不调用模型，也不读取真实凭证：

```powershell
npm.cmd run check
npm.cmd run check:package
npm.cmd run test:windows
```

`test:windows` 使用可删除的临时项目，验证中文/空格/单引号路径、UTF-8、空参数/内嵌引号、原生命令错误、项目外读取拒绝、`.env` 读取拒绝以及 Analysis 只读写入拒绝。它退出时清理临时项目及 sandbox session。

## 启动与登录

```powershell
node .\bin\pi.mjs setup
node .\bin\pi.mjs --workspace 'C:\Research\My Project'
```

在 Pi 中使用 `/login` 配置模型认证。Codex worker 使用独立的 Codex CLI 登录；先在 PowerShell 中执行 `codex login`。标准 npm 安装的 Codex `.cmd` 会被解析到其 Node 入口并用 argv 数组启动；非标准 batch shim 不自动交给 cmd.exe，需配置原生可执行文件。

也可 `npm.cmd link` 安装全局 `pi` 命令；不希望受本机 PowerShell 脚本执行策略影响时，使用 `pi.cmd` 或上述 `node bin/pi.mjs`，不需要为此全局设置 ExecutionPolicy Bypass。

默认受项目边界约束。`--full-access` 是显式的宿主用户权限模式，并非 sandbox 替代品；Analysis 仍需只读边界。不应为了安装或检查失败而自动开启它。

代码、日志和配置仍分别存放。默认配置在 `%APPDATA%\Research-Pi`，状态在 `%LOCALAPPDATA%\Research-Pi\state`；`pi paths` 可查看本机实际路径。远程 SSH 中的命令使用远端操作系统 shell，不把远端 Linux 脚本翻译成本地 PowerShell。

## 首轮实测清单

1. 完成 `npm.cmd run test:windows`；保留完整错误，勿靠关闭权限检查使其通过。
2. 在 Git 临时项目启动 Pi，让 agent 通过 `powershell` 输出版本、写读一个中文文本并执行一条非零退出命令。确认没有调用 Bash。
3. 开启 Analysis，确认可读项目文件、不能修改；再回到 Leader，确认权限转换后可写。
4. 启动一个 Pi general worker，接收结果；测试一次取消，不遗留子进程。
5. 配置 Codex 后先运行 `node .\bin\pi.mjs doctor --workspace 'C:\Research\My Project'`，再启动一个短 executor/advisor 任务。
6. 验证 TUI 输入、resize、Ctrl+C 与关闭后的会话恢复。这里的恢复是重新打开已保存会话，不是恢复已终止的计算进程。

反馈时提供：Windows/PowerShell/Node 版本、分支 commit、失败命令、退出码和相关错误片段。不要发送 auth.json、credentials.env 或 token。

## 已完成的验证与维护

开发环境为 macOS。已通过 70 项定向测试、语法检查和打包检查，包括离线平台参数测试、实际 Node shim 参数往返测试及既有回归；这些不能证明 Windows ACL、WFP、终端、模型登录和进程取消已在 Windows 通过。`test:windows` 是为你的实机验收准备的入口。

后续从 main 单向合并。平台代码集中在 windows-native 模块和执行边界；通用缺陷可单独修复 main，Windows 适配不反向合并。每次合并后运行上述三项检查与短 worker 实测。
