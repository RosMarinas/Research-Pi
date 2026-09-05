> **2026-09-06 · 重要前缀缓存修复**：移除动态 Delta，改为初始化/compact 时建立固定快照并保留通信历史；进一步修复 Runtime 消息唤醒后工具续轮的 system prompt 回退，避免长上下文前缀被反复改写。

# Research Pi

简体中文 · [English](README_en.md)

> Session is not enough for research. Project is.

Coding Agent不一定是好用的Research Agent。

Research Pi 面向 AI、机器人、通信、优化与仿真等计算实验科研。它最关心的不是“代码写的对不对”，而是：**代码能否支撑实验？这个实验告诉了我们什么？下一步高信息增益的实验是什么？**

它不是一段更长的科研提示词，也不是一个号称能自动完成科研的 skill。它把项目进度、实验记录、讨论和 Agent 协作留在 Project 中，因此换一个 Session、换一个模型，也不用从头讲起。

`Pi Core 0.84.2` ·  `macOS / Linux / WSL2`

## 设计原则

1. **项目比对话更长寿**：Session 可以结束，模型可以更换，但研究问题、实验结果和关键决定应该留下来。
2. **科研必须要人参与**：Agent 可以查资料、写代码、跑实验和整理证据，但不会因为命令成功就擅自宣布“方向成立”。
3. **记住真正有用的东西**：重点保留问题、假设、证据、失败路线和下一步，而不是把所有聊天都塞回模型上下文。
4. **让不同模型做擅长的事**：Pi 把握研究主线，Codex 负责长程执行，Pi-analysis 陪用户理解、质疑和讨论。它们交换的是短消息，不是彼此整段复制上下文。
5. **先找到对的方向，再把代码写漂亮**：探索阶段允许大胆替换、快速试错和整体回滚；方向值得保留后，再补工程质量与复现能力。

## 设计特点

🧠 **换对话，不丢研究主线。** Harness 把项目目标、关键决定、最新进展和交接记录保存在对话之外。新 Session 按角色载入项目快照；compact 后接续记忆，不必每次从头解释。日常交流沿用当前历史，不反复塞入动态摘要。

🔎 **实验做过，就能找回来。** 实验账本记录问题、干预、观察和有效性判断，失败实验也有位置。默认检索当前项目，也支持跨项目搜索全局已索引的实验记录，让过去的证据成为下一次判断的起点。

📬 **各自思考，短消息协作。** Leader 推进主线，Codex 执行任务，Analysis 独立讨论。通信经过持久 mailbox：进度更新不打断思考，需要决策或任务结束时再交给当前 Leader；换 Session 后，待处理消息仍能接续。

下面的通信流程简化自 thesis 中的通信图：

```mermaid
sequenceDiagram
    actor U as 用户
    participant L as Pi Leader
    participant R as Project Runtime
    participant C as Codex 执行器
    participant A as Pi-analysis
    U->>L: 研究问题与决策
    L->>R: 委派任务
    R->>C: 任务与项目上下文
    C-->>R: 进度记录（不唤醒 Leader）
    opt 需要输入
        C->>R: ASK 写入 mailbox
        R->>L: 投递给当前 Leader
        L->>R: 回答 / 调整方向
        R->>C: 继续原任务
    end
    C->>R: 结构化结果
    R->>L: 投递结果并记录回执
    A->>R: 讨论后的短便签（建议，不是证据）
    R->>L: 合适时机投递，轮换后跟随新 Leader
    L->>U: 证据、边界与下一步
    Note over L,A: 对话各自保留，不复制整段历史
```

## 我最喜欢的设计：双 Session 工作流

得益于记忆、通信、权限机制的良好设计，Research Pi 可以同时开两个窗口：一边让 **Pi Leader** 推进实验，另一边在 **Pi-analysis** 里随时追问、质疑和展开想法。

![Research Pi 双 Session 工作台：Pi Leader 推进实验，Pi-analysis 独立讨论，只向主线投递一张短便签](docs/assets/dual-session-workbench.png)

Pi-analysis 的长对话留在自己的窗口里，不会挤进 Leader 的上下文。只有当讨论形成了值得主线知道的判断，才把它整理成一张短便签送过去。

用户可以在一个终端让 Pi Leader 持续工作，在另一个终端随时进入 Pi-analysis：

```sh
# Terminal A：持续推进科研主线
pi

# Terminal B：跟进、理解和讨论，不干扰 Leader
pi --analysis
```

Pi-analysis 看到的是同一个项目的最新工作视图，但它有自己的对话空间。讨论可以很长，真正发给 Leader 的只需要是一张简短“便签”：

```text
/analysis send 当前判断、关键依据、仍存不确定性与建议下一步
```

这张便签通过 mailbox 交给 Leader，只包含讨论后的判断、依据和建议，不会把整段聊天塞进主线。Leader 空闲时可以立即看到；如果它正在工作，便签会等到合适的时机再送达。

于是主线可以安静地跑，用户也始终有一张可以放心提问和思考的桌子。独立 Codex 讨论 Session 也能通过 `pi analysis context` / `pi analysis send` 使用同一张“便签”。

## 快速开始

要求 Node.js `>=22.19`。Research Pi 当前使用 Unix 风格的工具链；Windows 推荐通过 **WSL2** 使用，不建议直接在原生 PowerShell 中运行 Agent。

### macOS / Linux

```sh
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#main'
pi setup
pi paths
```

### Windows（使用 WSL2）

先在管理员 PowerShell 中安装 Ubuntu：

```powershell
wsl --install -d Ubuntu
```

随后打开 Ubuntu，安装 Linux 版 Node.js `>=22.19` 和基础依赖：

```sh
sudo apt update
sudo apt install -y git zsh ripgrep fd-find bubblewrap socat
node --version
npm --version
```

然后选择一个分支安装：

| 分支 | 适合谁 | 与另一个分支的主要区别 |
|---|---|---|
| `main` | 已经把项目严格放在 WSL `/home/...`、希望与 macOS/Linux 保持完全一致 | 更新最快；宿主命令可按项目持久授权，不额外检查 Windows interop |
| `windows-research-pi` | 希望 Agent 高自动执行，但必须更强地隔离 Windows 系统盘 | WSL2-only 预览；拒绝 `/mnt/*` workspace，阻断 `.exe`/PowerShell/cmd/WSL interop，host command/project script 只能一次批准，缺少 seccomp 时拒绝启动 |

普通 WSL2 使用可以安装 `main`：

```sh
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#main'
pi setup
```

需要严格 Windows 宿主隔离时安装 Windows 分支：

```sh
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#windows-research-pi'
pi setup
mkdir -p "$HOME/research"
pi doctor --workspace "$HOME/research"
pi paths
```

无论选择哪个分支，都应把 Research Pi 和科研项目放在 `~/research/...` 等 WSL 文件系统中，不要放在 `/mnt/c` 或 `/mnt/d`。`windows-research-pi` 不是功能更多的 Windows 版：它定期跟随 `main` 的 Runtime/ProjectView/模型能力，只额外收紧 WSL 与 Windows 宿主之间的执行和文件边界。详细安装、检查项与限制见 [Windows / WSL2 指南](docs/windows-wsl-guide.md)。

进入 TUI 后用 Pi 原生 `/login` 登录供应商，再用 `/model` 切换模型；Research Pi 不再维护第二套模型/profile 目录。若供应商使用 API key，或需要 DeepSeek 小型搜索，也可以在 `pi paths` 给出的 `credentialsPath` 中填写：

```dotenv
DEEPSEEK_API_KEY=...
ZAI_API_KEY=...
OPENCODE_API_KEY=...
```

然后在科研项目中启动：

```sh
cd /path/to/research-project
pi
```

如果只想阅读结果、讨论和分析，而不允许当前 Session 改代码或启动实验：

```sh
pi --analysis
```

首次接入现有项目时，可以直接说：

```text
先只读恢复当前研究状态：识别研究目标、竞争假设、已有证据、失效路线和关键未决问题。
不要立即启动大实验；先说明 ProjectView 缺少什么，以及下一步最有信息量的动作。
```

## 核心能力

| 能力 | 作用 |
|---|---|
| Research Contract | 让 Agent 默认采用探索、证伪、有效性检查和证据驱动收敛 |
| Project Runtime | 维护 Project State、Actors、Actions、mailbox 与 Leader Session 所有权 |
| Dual Session | Leader 持续推进主线，Pi-analysis 独立跟进与讨论，并只把最终短综合投递给 Leader |
| ProjectView | 初始化与 compact 时载入固定项目快照：`RESEARCH.md`、Project Brief 与当前研究进展；日常轮次只追加对话和工具结果 |
| Research Memory | 对历史 Session 和实验记录做本地全文检索，不依赖向量数据库 |
| Research Compaction | 在模型 settled 后生成带 provenance 的结构化状态，而不只摘要聊天文本 |
| Experiment Records | 用 `record_experiment` 区分观察、有效性和解释；支持换轨与窄幅状态修订 |
| Codex Collaboration | 以可续接 mission 调用 advisor/executor，并通过 Runtime mailbox 与 Pi 通信 |
| Project Boundary | 默认把模型命令限制在当前项目；SSH、外部文件和宿主命令通过显式 capability 授权 |
| Research Briefing | 在重大结果或阶段交接时恢复工作脉络，并把内部术语翻译成用户可判断的报告 |

ProjectView 在项目上下文初始化和成功 compact 后捕获一次：用户维护的 `RESEARCH.md` 保留项目意图，Project Brief 概括总体方向与已结束阶段，当前研究进展补齐交接位置。快照在普通轮次间保持不变，不再自动追加或移动 Delta；新进展通过用户消息、工具结果和一次投递的通信进入历史，已消费的消息也保留在历史中。实时视图和实验账本仍可按需查看；角色或上下文显式切换时会重新建立快照，使日常轮次保持已发送前缀稳定。

建议每个长期科研项目维护一份短 `RESEARCH.md`，只写不容易频繁变化的内容：项目要解决什么、最终成功是什么、总体路线、明确不做什么，以及用户最在意的判断原则。不要把实验流水账、当前 run 或每日 TODO 放进去。Research Pi 在建立快照时链接并载入前 3600 个字符；文件修改不会自动重写当前 Session 的前缀，急需生效的变化请在对话中说明或让 Agent 读取文件，下次 compact 或新 Session 再统一更新快照。

```md
# Project North Star

## Problem and final goal
...

## Overall approach
...

## Non-goals and decision principles
...
```

ProjectView 本身是派生视图，不提供会误删项目账本的“全局清空”按钮。需要不带项目记忆的独立环境时使用 `/runtime new clean`；Analysis Session 可用 `/runtime context off` 暂停注入。删除或修改 `RESEARCH.md` 只影响 Anchor，实验、Runtime 和历史 Session 都会保留。

## 常用入口

| 命令 | 用途 |
|---|---|
| `/runtime` | 查看 ProjectView、Actors、Actions、mailbox 和 Session 状态 |
| `/runtime rotate` | 新建不复制旧 transcript、但继承 Project 状态的 Leader Session |
| `pi --analysis` | 新开只读 Analysis Session；不抢占 Leader，不接收其 mailbox |
| `/analysis send <摘要>` | 把有价值的讨论投递给 Leader；用 `/runtime promote <原因>` 转为 Leader |
| `pi analysis context/send` | 让独立 Codex Session 读取 ProjectView 或向 Leader 投递不超过 1200 字符的综合 |
| `/runtime context <on\|off>` | Analysis 保持只读角色，只切换后续轮次是否注入 ProjectView |
| `/runtime new clean` | 新建不继承 ProjectView 的纯净 Session；用 `/runtime inherit` 恢复 |
| `/memory <query>` | 搜索当前 Project 的历史 Session 与实验记录 |
| `/side <问题>` | 隔离追问；有价值时用 `/side use <id>` 提升到主线 |
| `/watch` | 观察 Codex 的命令、文件修改和 subagent 活动，不污染 Leader 上下文 |
| `/actors`、`/inbox` | 查看活跃 Actor 和待处理 Runtime 消息 |
| `/login`、`/model`、`/scoped-models` | 使用 Pi 原生认证、模型切换和模型范围；Research Pi 不再复制供应商目录 |
| `/config` | 查看统一配置和切换主题 |
| `/boundary doctor` | 检查项目、Git、Python、sandbox 与 Codex 环境 |

模型可直接调用的研究工具包括 `record_experiment`、`record_research_transition`、`amend_project_state`、`research_checkpoint`、`research_memory_search/read`、`codex_delegate` 和 `host_capability`。

## 安全与数据

- 模型 shell 默认可读写当前项目和正常 Git 数据；其他项目、宿主凭据和 Unix socket 不自动开放。
- SSH target、项目外只读文件和宿主命令需要一次、当前 Session 或当前 Project 范围的明确批准。
- 私钥、`.env`、API key、keychain 和云凭据不能进入模型上下文。
- 配置、Session、Runtime、Codex job、授权账本和 trace 位于用户状态目录，不进入科研仓库。
- `pi-traced` 可能记录完整 prompt 与工具内容，只应短时诊断；默认 trace 和 Codex DEBUG SQLite 日志均关闭。

## 配置与目录

```text
~/.config/research-pi/        config.json、schema、credentials.env
~/.local/state/research-pi/   sessions、Runtime、memory、Codex、grants、trace
<research-project>/.pi/       项目实验记录与 checkpoint
```

实际路径以 `pi paths` 为准。Research Pi 的 `config.json` 只管理 Runtime、compact、Codex、搜索、资源与 UI；Leader 的供应商、模型、thinking 和自定义模型由 Pi 原生配置管理：

```sh
pi config show
# TUI 内：/login、/model、/scoped-models、/settings
```

Research Pi 关闭全局 skill/extension 自动发现，只显式加载审查过的 Harness 扩展、内置 `research-briefing` 和配置白名单。

## 开发与验证

```sh
git clone git@github.com:RosMarinas/Research-Pi.git
cd Research-Pi
npm install --ignore-scripts
cp .env.example .env
./install-user.sh

npm run check
npm test
npm run test:package
```

- `pi`：运行 Research Pi Harness。
- `pi-raw`：运行锁定的原始 Pi Core，便于行为对照。
- `pi-traced`：临时启用敏感 trace。
- `./run-pi.sh --workspace /path/to/project`：从源码 checkout 直接运行。

### Windows / WSL2

Windows 上的最小迁移路线是 WSL2，而不是让现有 Bash harness 直接由 PowerShell 解释。`main` 可以作为普通 WSL2 Linux 环境运行；如果还要求强制阻断 Windows 系统盘和宿主 interop，则使用 `windows-research-pi`。两种情况下都应把科研项目放在 WSL 自身的 `/home/...` 文件系统中。

Windows 分支在启动时额外要求 WSL2、bubblewrap、socat、ripgrep、`fd`/`fdfind` 和可用的 seccomp helper，并执行无副作用的 Windows host-interop 探针。缺少 seccomp、项目位于 `/mnt` 或 `cmd.exe` 能从沙箱中成功启动时，边界会 fail closed。项目认可的 SSH target 可以持久自动使用；通用 host command/project script 只能一次性批准。安装步骤、分支对照和边界说明见 [Windows / WSL2 指南](docs/windows-wsl-guide.md)。

## 文档

- [基本使用指南](docs/pi-basic-guide.md)
- [统一配置说明](docs/configuration.md)
- [Project Runtime 测试与恢复](docs/research-runtime-test-guide.md)
- [Windows / WSL2 安装与安全边界](docs/windows-wsl-guide.md)
- [安全模型与本地数据](docs/security-model.md)
- [设计思想](thesis/ResearchPi.pdf)



## License

Research Pi 的原创代码与文档采用 [MIT License](LICENSE)。第三方组件保留各自许可证，详见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
