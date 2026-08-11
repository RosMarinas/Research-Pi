# Research Pi 基本使用指南

这份指南面向 Research Pi：Pi 0.84.1、DeepSeek V4 Flash、thinking `max`。源码 checkout 用于快速开发；稳定版本作为 npm CLI 全局安装。两种形态的日常入口都是 `pi`。

## 1. 启动

```bash
cd /path/to/research-project
pi
```

第一次交互式启动若出现 project trust 提示，确认信任本项目的 `.pi` 配置。进入界面后直接输入自然语言任务并按 Enter。

源码开发时，可以从 harness 目录显式启动：

```bash
cd /path/to/research-pi-harness
./run-pi.sh --workspace /path/to/research-project
```

需要原始官方行为或本地 trace 时：

```bash
pi-raw
pi-traced
```

科研 prompt、DeepSeek 配置、研究工具、Codex executor 和 session 由 harness 提供；文件操作、Git checkpoint、Codex 委派和实验账本作用在启动 `pi` 时所在的研究仓库。所有项目的 Research Pi session 集中保存在当前运行形态的状态目录，每个 session header 仍记录其原始工作目录。

稳定包首次安装后运行 `pi setup`，随后在 `~/.config/research-pi/credentials.env` 填入 DeepSeek key。稳定包的 session、memory、Codex job、grant 和 trace 默认集中在 `~/.local/state/research-pi/`；源码开发入口仍使用 checkout 的 `.env` 与 `.pi/`，保证修改后可立即试用。`pi paths` 可确认当前运行的是哪一种形态。

Research Pi 默认关闭 Pi 的 skill 和 executable extension 自动发现，只加载经过检查的研究白名单与 harness extensions。某次任务需要额外 skill 时可显式添加：

```sh
pi --skill /path/to/skill
```

显式路径仍遵循 Pi 的原生 skill 加载与渐进披露机制。

目标项目自己的 extension 也必须由你显式授权加载：

```sh
pi --extension /path/to/project/.pi/extensions/example.ts
```

Extension 在 Pi 宿主进程内运行，不属于模型 shell，因此只加载你信任的代码。

推荐先给会话命名，便于以后查找：

```text
/name 排查训练不稳定
```

退出使用 `/quit`，也可以连续按两次 `Ctrl+C`。

## 2. 怎样描述科研任务

不需要写成固定表单。至少让 Pi 知道研究目标、现象或已有证据，以及什么结果会改变判断。例如：

```text
阅读当前项目。我们观察到验证损失在第 3 个 epoch 后突然上升。
请先形成几个有实质差异的竞争假设，再选择信息增益最高的探针。
可以写一次性代码和运行小实验，但在根据结果更新判断前检查实验是否真的表达了预期介入。
```

需要指定文件时，在编辑器输入 `@`，模糊搜索并插入项目文件：

```text
比较 @configs/baseline.yaml 和 @configs/new.yaml，判断哪些差异最可能解释性能下降。
```

比较有效的科研任务写法：

- “区分这些竞争假设”，而不只是“修复当前实现”；
- “先做一个能证伪路线的探针”，而不只是“写完整功能”；
- “判断这个负结果是否有效”，避免把实现错误当成研究反证；
- “如果现有抽象限制了实验，可以写旁路或 throwaway prototype”。

项目的 `.pi/APPEND_SYSTEM.md` 已经提供默认科研原则，所以不必每次重复全部工作约定。

## 3. Pi 能做什么

当前 Pi 可以直接使用这些内置工具：

- `read`、`grep`、`find`、`ls`：阅读和搜索项目；
- `edit`、`write`：修改或创建文件；
- `bash`：运行脚本、测试和实验命令。

Pi 会自行选择工具。若想明确控制，可以直接说：

```text
先只读分析，不修改文件，也不启动训练。
```

或者：

```text
允许修改和运行一个低成本探针；不要进行完整训练。
```

在输入框中用 `!command` 可由你直接运行 shell 命令，并把输出发送给模型：

```text
!git status --short
```

`!!command` 会运行命令但不把输出加入模型上下文。`!` / `!!` 是人工直执行通道，会以你的系统权限运行并在首次使用时警告；模型的 `bash` 则受当前项目边界约束。输入 `/boundary` 可查看生效根目录和权限。

安装、升级或权限异常后先运行 `pi doctor`；交互会话内可运行 `/boundary doctor`。它们不调用模型，会验证项目、Git、Python 与 Codex sandbox 的真实权限。每个 Codex job 也会在模型启动前自动执行 preflight。

模型 shell 可读写当前项目（包括正常 Git commit 所需的 `.git` 数据），并可访问公网。项目内的 `uv`、Python、shell、Node、Git 和测试命令可直接运行，`sh -c` 或 `python3 -c` 不会仅因语法形式被拒绝。其他项目、宿主凭据和 Unix socket 仍在 sandbox 外；需要 SSH 或宿主权限时，Pi 会通过 `host_capability` 请求一次/session 授权，或复用当前项目已信任的 SSH target/command prefix，而不是默认让你复制命令到终端。

常用预授权示例：

```text
/boundary trust-ssh 931server
/boundary trust-command uv run remote_run.py
/boundary trust-command python3 remote_run.py
/boundary trust-command ./sync.sh
/boundary grants
```

`trust-*` 按项目持久保存，`grant-*` 只在当前 Pi session 生效。持久规则保存在用户状态目录而不是仓库中；源码开发模式下位于 Git 忽略的 `.pi/capabilities/`。`host-command` 会在授权界面显示 cwd、完整 argv 和建议前缀，并以宿主用户权限运行，所以只信任你认可的项目入口；不透明 `ssh-target` 的凭据内容不会进入模型。

所有模型工具调用都会在底部状态栏显示工具名、经过截断和凭据遮蔽的目标摘要以及已运行时间；成功或失败终态保留 5 秒。多个工具并行时显示数量和最近启动的工具。Codex 后台 job 使用独立的持久状态，不受这个 5 秒终态影响。

Pi 现在提供这些低摩擦研究工具：

- `record_experiment`：当一个运行结果真正支持、削弱或无法区分研究假设时，Pi 可调用它追加一条 `.pi/research/experiments.jsonl`。普通搜索和调试不会自动记录。
- `research_checkpoint`：在大步替换、回滚或废弃路线前，把当前 tracked Git 状态保存到 `refs/pi-research/checkpoints/...`。它不会切分支或清理工作树，也不会捕获 untracked 文件。
- `research_memory_search`：在旧 session 和实验记录中进行本地全文检索；默认仅限当前 Git 项目，并排除当前 session 和废弃分支。
- `research_memory_read`：根据搜索结果中的 session/entry ID 读取精确原文和小范围上下文。
- `/side <问题>`：用当前上下文做一次隔离追问并持久保存；默认不进入主上下文。
- `web_search`：通过 DeepSeek 原生搜索做简单、直接、带来源的网页查找。
- `codex_delegate`：把工具密集或长程执行交给独立 Codex 上下文，或请求一个只读第二意见。Pi 仍负责研究规划与证据判断。

可以直接提出：

```text
如果这个结果足以改变研究判断，先检查有效性，再调用 record_experiment 记录一次。
```

```text
下一步要整体替换当前实现；先用 research_checkpoint 保存这个研究决策点。不要自动提交当前分支。
```

当任务依赖过去的实验或旧会话时可以直接说：

```text
先用 research_memory_search 查找之前关于梯度爆炸和 run-184 的实验；读取精确 entry 后再判断，不要把旧 assistant summary 当成实验事实。
```

人类也可使用 `/memory 梯度爆炸` 查看少量检索结果。`/memory` 不会把结果加入模型上下文；Research Pi 也不会自动在每一轮注入历史。

临时追问但不希望扩大主上下文时：

```text
/side 如果当前异常其实来自评价协议，而不是模型结构，会出现哪些可区分现象？
```

side 问答会以卡片保存在 session 中。`Ctrl+O` 展开完整内容，`/side show <id>` 单独查看，`/side use <id>` 才把它提升到主上下文。之后也能通过 Research Memory 找回，但它仍属于 assistant synthesis，不是实验事实。

需要当天信息、一个官方页面或一份有界小调研时，可以让 Pi 调用 `web_search`。它复用 Research Pi 配置中的 DeepSeek key。用户明确指定，或任务确实需要大量搜索、交叉核验和中间材料整理时，再交给 Codex 隔离过程。

需要 Codex 实际完成一项较长任务时，可以直接对 Pi 说：

```text
把数据加载重构和完整回归测试交给 Codex executor。目标是消除当前内存峰值，允许它在项目内修改、删除、提交和运行实验。Codex 使用 gpt-5.6-sol/max；你负责给出成功标准，并在它返回后审查证据。若远程运行需要项目外 SSH 凭据，让它返回准确命令给我批准或直接执行。
```

Pi 会获得一个 `codex-...` job ID。底部状态栏会持续显示 job 后八位、advisor/executor 模式、`starting/running/completed/failed/cancelled` 状态和最近进度；即使后台工具调用已返回也会继续更新。后台任务未结束时，应查询同一 job 的 status/result，或用 resume 继续该 Codex thread，而不是重复启动任务。默认 executor 是 project-write + public-network，advisor 是 project-read + public-network；两者默认都是 `gpt-5.6-sol/max`，也可以在具体委派时指定其他 Codex model。

Pi 在连续处理同一研究子任务时应使用稳定、简短的 `mission` 标签。带 mission 的新派遣默认 `reuse=auto`：运行中的同 mission/mode job 会直接重新挂接，已完成的会通过 App Server `thread/resume` 续接历史；不同 workspace、不同 mode 或不同 mission 不会自动复用。续接时 Harness 会比较 Git snapshot，工作区发生变化则显式要求 Codex 重新检查当前文件。使用 `/codex missions` 查看当前 workspace 的任务链；若要独立第二意见、开始另一研究路线或主动清除旧假设，使用新的 mission。

## 4. 会话、分支和恢复

普通会话会自动保存到 Research Pi 的集中状态目录，而不是散落在每个科研仓库中。源码开发模式使用 harness 的 `.pi/sessions/`；稳定包使用 `~/.local/state/research-pi/sessions/`。历史检索依据 session header 中的 cwd/Git 根目录区分项目。

| 操作 | 用法 |
|---|---|
| 查看当前会话、token 和费用 | `/session` |
| 给会话命名 | `/name 名称` |
| 浏览并恢复旧会话 | `/resume` |
| 新建空会话 | `/new` |
| 查看或切换当前会话树 | `/tree` |
| 从较早的用户消息创建独立会话 | `/fork` |
| 将当前分支复制为新会话 | `/clone` |
| 压缩较早上下文 | `/compact` |
| 检索历史会话但不注入模型 | `/memory 查询` |
| 隔离追问并持久保存 | `/side 问题` |
| 查看/提升 side 内容 | `/side show <id>`、`/side use <id>` |
| 查看最近结构化科研状态 | `/research-state` |

科研中推荐这样区分：

- 竞争假设 A/B 仍属于同一问题：使用 `/tree`，保留在同一会话树中；
- 已经切换成新的研究问题或正式实验阶段：使用 `/fork` 或 `/new`；
- 会话很长但仍在解决同一问题：可手动使用 `/compact`。Research Pi 也会在约 272K/384K 总上下文处自动触发，并按当前分支第 1/2/3 次 compact 保留约 32K/40K/48K recent tail；竞争假设、有效性、evidence refs 与下一实验写入结构化 compact，完整 JSONL 历史仍保留。
- 新会话需要恢复旧证据：使用 memory search/read，不必先恢复整个旧 session。

从终端恢复最近会话：

```bash
./run-pi.sh -c
```

浏览选择历史会话：

```bash
./run-pi.sh -r
```

## 5. 常用界面操作

输入 `/` 会打开全部 slash command 补全；Pi 0.84.1 没有单独的 `/help` 命令。

| 按键 | 作用 |
|---|---|
| `Escape` | 中止当前生成或工具执行 |
| 连按两次 `Escape` | 打开会话树 |
| `Shift+Enter` | 输入多行文本 |
| `Shift+Tab` | 切换 thinking level |
| `Ctrl+L` | 打开模型选择器 |
| `Ctrl+O` | 展开或折叠工具输出 |
| `Ctrl+T` | 展开或折叠 thinking 内容 |
| `Ctrl+X` | 复制上一条模型回复 |
| `/hotkeys` | 查看完整快捷键 |

注意：单次 `Ctrl+C` 是清空编辑器；连续两次才退出。中止运行应使用 `Escape`。

## 6. 一次性任务和自动化入口

不进入交互界面，执行一次任务后退出：

```bash
./run-pi.sh --approve -p "阅读 README.md，概括项目目标和当前未验证边界"
```

不保存会话的一次性探针：

```bash
./run-pi.sh --approve --no-session -p "读取 .pi/settings.json，只报告默认模型"
```

供脚本解析的 JSON event stream：

```bash
./run-pi.sh --approve --no-session --mode json -p "检查当前配置"
```

`--approve` 在非交互运行中明确允许加载当前项目的 `.pi` 资源；交互模式保存过 trust 决定后通常不需要它。

需要诊断模型实际请求、reasoning 回放、工具调用和延迟时，显式启用本地 trace：

```bash
./run-pi-traced.sh
```

真实仓库同样支持 `--workspace`。源码开发模式的 trace 写入 harness 的 `.pi/agent/traces/`，稳定包写入用户状态目录的 `agent/traces/`；输入 `/trace` 可生成并打开 HTML。trace 保存完整 prompt、工具参数和输出，不要在包含未脱敏秘密的任务中随意启用或分享。

## 7. 三个可直接使用的示例

### 阅读一个陌生科研项目

```text
先只读探索这个项目。概括研究问题、数据流、模型、训练入口和评价指标。
指出当前实现隐含的关键假设，以及最值得先验证的三个不确定点。不要修改代码。
```

### 诊断实验结果异常

```text
这次运行的指标比 baseline 低 8%。请区分环境/配置问题、实现错误、实验无效和研究假设被反证这四类解释。
先检查 run identity 和最低有效性条件，再选择一个最能区分解释的低成本实验。
```

### 探索替代方向

```text
当前方案已经连续两次只修补同一症状。请停止局部打补丁，回到问题定义。
提出至少一个跳出现有抽象的替代方向，并设计能快速比较当前路线和替代路线的实验。
```

## 8. 当前边界

- API key 只放在项目 `.env`，不要粘贴进 prompt、日志或实验文档；
- DeepSeek Web Search 会额外产生模型和搜索相关 token 开销；简单检索也应保持有界；
- Pi 的模型 shell 受 OS 级 sandbox runtime 约束，Codex executor 使用 project-only permission profile：项目可写、Git commit 可用、公网开放，项目外用户文件和 Unix sockets 默认不可用；Pi shell 的通用系统 temp 写入被关闭，仅保留 Apple Git 所需的窄 `xcrun_db` 系统缓存例外；Codex CLI 0.146 仍自带系统 temp 兼容路径，Harness 已将 `TMPDIR` 指向项目内并禁止主动越界，但这一处目前是纵深防御，不与 Pi shell 等强；
- `.git/hooks` 是项目内唯一默认只读的 Git 子路径，防止实验任务植入后续持久执行；`.git/config`、objects、index 和 refs 可写；
- 项目内任意 `uv`、Python 和 shell 命令由 sandbox 约束效果，而不是由命令字符串白名单约束；需要宿主 SSH/config/agent 的入口通过一次/session/project 三档 host capability 授权；
- 项目持久 `trust-ssh` 绑定精确 target，`trust-command` 绑定界面显示的 argv 前缀；代码字符串默认绑定完整 argv。它们可被 Pi 与 Codex executor 自动复用，也可用 `/boundary revoke` 撤销；
- `!` / `!!` 与人工批准的直接文件工具仍是最终越界通道，但 broker 能表达的操作应由 agent 申请授权后继续执行，不应常态化退回用户手动运行；
- memory SQLite 是派生缓存，不进入 Git；它会脱敏常见凭证形式，但原始 session、实验账本和不常见秘密格式仍是敏感数据；
- Research Pi 在约 272K 总上下文时主动 compact，384K 作为硬触发线；压缩后原始 recent tail 按当前分支第 1/2/3 次 compact 取约 32K/40K/48K，之后固定在 48K；
- 当前适合科研探索；极限上下文、长期多分支召回和 Codex 无人值守远程执行仍需在真实任务中继续验证；
- 先让真实任务暴露摩擦，再加入 extension 或工作流，不预先安装全家桶。
