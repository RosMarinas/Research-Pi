# Research Pi

简体中文 · [English](README_en.md)

Research Pi 是一个科研助手：帮你读代码、设计和运行实验、整理结果，也可以把独立任务交给其他模型。研究目标、关键决定和实验记录保存在项目中，换会话时不用全部从头解释。

**当前分支用于原生 Windows，直接运行在 PowerShell 中，不需要 WSL。**

| 你的环境 | 使用分支 |
| --- | --- |
| Windows + PowerShell | `windows-powershell-research-pi`（本分支） |
| Windows + WSL2 | `windows-wsl-research-pi` |
| Linux / macOS | `main` |

## 安装和启动

先安装 **PowerShell 7.6+、Node.js 22.19+ 和 Git**。打开 Windows 自带的 PowerShell，依次执行：

```powershell
winget install --id Microsoft.PowerShell --exact --source winget --installer-type wix
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id Git.Git --exact --source winget
```

这些命令安装 PowerShell 稳定版、Node.js LTS 和 Git。如果找不到 `winget`，先在 Microsoft Store 中安装或更新“应用安装程序”。

安装完成后，关闭终端，从开始菜单重新打开 **PowerShell 7**（不是 Windows PowerShell 5.1），确认版本：

```powershell
$PSVersionTable.PSVersion
node --version
git --version
```

PowerShell 应为 7.6 或更新的 7.x 稳定版，Node.js 应不低于 22.19。然后下载 Research Pi：

```powershell
git clone -b windows-powershell-research-pi https://github.com/RosMarinas/Research-Pi.git
Set-Location Research-Pi
npm.cmd ci
```

首次使用需要安装命令沙箱。这一步会弹出 Windows 权限确认：

```powershell
node .\node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js windows-install
npm.cmd run test:windows
```

检查通过后，创建配置并打开你的科研项目。把下面的路径换成实际项目目录：

```powershell
node .\bin\pi.mjs setup
node .\bin\pi.mjs --workspace 'C:\Research\My Project'
```

上面的命令都在 Research Pi 仓库目录中执行。使用这个明确入口，也能避免与电脑上其他同名 `pi` 命令混淆。

## 连接模型

进入 Pi 后，用 `/login` 登录支持的服务，再用 `/model` 选择模型。

如果使用 API key，先运行：

```powershell
node .\bin\pi.mjs paths
```

打开输出中 `credentialsPath` 指向的文件，只填写需要的供应商：

```dotenv
DEEPSEEK_API_KEY=你的key
OPENCODE_API_KEY=你的key
ZAI_API_KEY=你的key
```

修改 key 后退出并重新启动 Pi。不要把 key 发到聊天里或提交到 Git。更多设置见[配置说明](docs/configuration.md)。

## 怎么用

直接描述你的研究问题，例如：

> 先读现有代码和实验记录，解释目前为什么训练没有改善。找到最值得验证的原因，再给出一个简单的对照实验。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/model` | 选择当前模型 |
| `/models` | 设置其他工作模型和分工 |
| `/actors` | 查看参与项目的助手 |
| `/watch` | 查看其他助手的工作 |

先用一个模型就可以。需要并行工作时，再配置 Codex 或 Antigravity。**Codex 需要单独安装 CLI 并运行 `codex login`；Pi 的登录不会替它登录。**

## 当前限制

这是原生 Windows 的预览分支。已完成离线回归测试，真实 Windows 上的终端、权限和模型交互仍需要实测。

目前支持前台终端和子助手；**暂不支持常驻后台、关闭终端后继续运行，以及 Web 访问**。需要这些功能时，使用 WSL2 分支。命令沙箱依赖的 Windows 支持也仍处于 alpha 阶段。

遇到问题时，请保留失败命令、错误信息，以及 Windows、PowerShell 和 Node 版本。不要通过关闭权限检查来掩盖错误。

- [Windows 安装、实测与排错](docs/windows-powershell-guide.md)
- [模型与配置](docs/configuration.md)
- [研究提示的组织方式](docs/research-prompt-contract.md)

## 更新

先结束当前会话，再在仓库目录执行：

```powershell
git pull --ff-only
npm.cmd ci
```

重新启动 Pi 即可。此分支单独维护 Windows 适配，不改动 Linux/macOS 主线。
