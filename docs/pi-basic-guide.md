# Research Pi 基本使用指南

这份指南面向 Research Pi：Pi 0.84.2、官方 DeepSeek 与精选 OpenCode Go profiles。源码 checkout 用于快速开发；稳定版本作为 npm CLI 全局安装。两种形态的日常入口都是 `pi`。

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

稳定包首次安装后运行 `pi setup`，随后在 `~/.config/research-pi/credentials.env` 填入 `DEEPSEEK_API_KEY` 和/或 `OPENCODE_API_KEY`。前者支持官方 DeepSeek Leader 与原生小型搜索，后者支持 OpenCode Go 的全部内置 profiles。稳定包的普通配置位于 `~/.config/research-pi/config.json`；session、project Runtime、memory、Codex job、grant 和 trace 默认集中在 `~/.local/state/research-pi/`。源码开发入口使用 checkout 的 `.env`、`.pi/config.json` 与 `.pi/` 状态；每个开发 worktree 的配置和运行状态彼此隔离。`pi paths` 可确认当前运行的是哪一种形态。

查看或切换配置：

```sh
pi config show
pi config list
pi config use opencode-go-flash
pi --profile deepseek-pro   # 只覆盖本次启动
```

进入 TUI 后输入 `/model` 或按 `Ctrl+L`，从 Research Pi 自动生成的 scoped 目录选择模型。模型、对应默认 thinking 和 `activeProfile` 会一起持久保存；恢复旧 Session 不会覆盖默认值。`/scoped-models` 是 Pi Core 低层入口，Research Pi 已从补全隐藏，日常不需要使用。API key 不在 `config.json` 中，始终单独保存在凭据文件。

所有字段、示例和覆盖优先级见 [Research Pi Configuration](configuration.md)。

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

`trust-*` 按项目持久保存，`grant-*` 只在当前 Pi session 生效。持久规则保存在用户状态目录而不是仓库中；源码开发模式下位于 Git 忽略的 `.pi/capabilities/`。`host-command` 会在授权界面显示 cwd、完整 argv 和建议前缀，授权后的 `/boundary grants` 会显示 grant ID；它以宿主用户权限运行，所以只信任你认可的项目入口。Pi/Codex 后续使用 grant ID 时自动恢复原 cwd；不带 cwd 的调用只有在唯一匹配时才自动恢复，多个 worktree 同时匹配会要求明确选择，不会创建 `bash -lc "cd ..."` 的重复授权。不透明 `ssh-target` 的凭据内容不会进入模型。

Codex executor 缺少 grant 时不再先失败后咨询 Leader。`research_pi_host` 会把精确操作保存为结构化 `input_required`，attached Pi TUI 自动弹出相同的授权框；你的选择自动恢复原 Codex tool call。没有可用 TUI 时请求继续保存在 Runtime inbox。权限 ask 只有在批准/拒绝或显式回复已送回 Codex 后才结算，Leader 仅仅读到它不会让请求从 inbox 消失。

所有模型工具调用都会在底部状态栏显示工具名、经过截断和凭据遮蔽的目标摘要以及已运行时间；成功或失败终态保留 5 秒。多个工具并行时显示数量和稳定摘要。Codex 后台 job 使用独立的持久状态，不受这个 5 秒终态影响；多个 Codex Action 或一个 Action 内的并发活动在单行 footer 中聚合，在 editor 上方 Runtime Dock 中按稳定顺序逐行展示。

Pi 现在提供这些低摩擦研究工具：

- `record_experiment`：当结果真正改变研究判断时，Pi 追加一条 `.pi/research/experiments.jsonl`，并区分 confirmatory、exploratory、diagnostic 与 validity_failure。只有 confirmatory 要求假设和观察前预测；不存在的 hypothesis、prediction、validityChecks、nextStep 不能事后补写。preregistered prediction 需要 `registrationRef`；未知 `trackRef` 会在写盘前拒绝。重试会去重，`runGitCommit` 与写记录时自动捕获的 `recordedAtGit` 分开保存。
- `record_research_transition`：当用户明确改变研究问题，或有效证据使旧路线成为 archived/superseded/parallel 时，记录一次 project-level 换轨。普通 next step、代码重构或 Codex completed 不触发；parallel 分支可用精确 `fromTrackRef` 指定从哪条 live route 继续。
- `amend_project_state`：当当前 ProjectView 只有局部字段需要依据明确用户决策、实验、run 或文档进行纠正时，提交带 Project revision 的 append-only patch。初始状态用 `/compact`，换轨用 `record_research_transition`；数组字段是整组替换，省略字段保持不变。
- `research_checkpoint`：在大步替换、回滚或废弃路线前，把当前 tracked Git 状态保存到 `refs/pi-research/checkpoints/...`。它不会切分支或清理工作树，也不会捕获 untracked 文件。
- `research_memory_search`：在旧 session 和实验记录中进行本地全文检索；默认仅限当前 Git 项目，并排除当前 session 和废弃分支。
- `research_memory_read`：根据搜索结果中的 session/entry ID 读取精确原文和小范围上下文。
- `/side <问题>`：用当前上下文做一次隔离追问并持久保存；默认不进入主上下文。
- `web_search`：通过 DeepSeek 原生搜索做简单、直接、带来源的网页查找。
- `codex_delegate`：把工具密集或长程执行交给独立 Codex 上下文，或请求一个只读第二意见。进度使用自然语言 `phase=commentary`，结构化结果由一次性的 `submit_research_pi_result` 提交，最后只保留简短 `phase=final_answer` acknowledgement；executor 用 `outcome=succeeded|partial|blocked|failed` 与 `goal_satisfied` 表达委派结果，不把 turn 的 `completed` 当作任务成功。Pi 仍负责研究规划与证据判断。
- `/watch`：按需打开 Codex 客观执行面板；左右切换 Action，Tab 或上下切换 overview/activity/agents，`q`/`Esc` 关闭。观察内容不进入模型上下文。
- `/actors`（等同 `/actors active`）、`/inbox`：查看当前 active/waiting 的 project Runtime Actors 与 durable mailbox；`/actors all` 查看历史注册和 suspended Actors。
- `/message`、`/steer`：面向 Actor 通信；steer 默认等待下一安全模型边界，只有 `--preempt` 才主动中断。
- `/runtime`（或 `/runtime board`）：打开 Project 控制面；左右或 Tab 切换 overview/actors/messages/sessions，`r` 手动刷新，`v` 查看完整 ProjectView。Actors 页用上下键选择，Enter 或 `w` 直接打开对应 Codex Watch。面板不进入模型上下文，也不后台轮询。需要注意的 Runtime 状态会通过 editor 上方的自折叠 Dock 显示。
- `/runtime health|recommend|view`：查看 Project Runtime 健康度、只读生命周期建议或当前 ProjectView。
- `/runtime takeover <reason>`：当另一 Session 正在占用 Research Leader 且确实需要人工接管时，显式转移 attachment；旧运行会在下一模型边界停止。
- `/runtime rotate [reason]`：在 Project State 可恢复且没有未知副作用时，人工创建一个不复制旧 transcript、但自动继承 ProjectView/mailbox 的新 Leader Session；Runtime 会记录交接和 receipt。不会自动触发。
- `/runtime new clean [reason]`：创建不复制 transcript、也不自动继承 ProjectView/mailbox 的 clean Session；Project 数据不删除，clean compact 不回写 Project State，Codex mission 的 `reuse=auto` 会降为新 thread。
- `/runtime inherit [reason]`：让当前 clean Session 从下一轮开始恢复 ProjectView、未消费 mailbox 与 project-aware 操作；旧 transcript 仍不会恢复。后续 compact 以 canonical Project State 为 previous state，已有 clean summary 只作为非权威候选综合。
- `/model`：唯一的日常 Leader 模型选择器；选择后持久化匹配 profile 和默认 thinking。
- `/config`：显示 Research Pi 配置摘要；`/config show|path|themes|theme <name>` 管理非模型设置，`use <profile>` 仅保留兼容。

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

side 问答会以卡片保存在 session 中。`Ctrl+O` 在展开/收起之间切换；如果终端状态异常，也可用 `/side collapse` 强制恢复紧凑视图。`/side show <id>` 打开可滚动 overlay，使用方向键/PgUp/PgDn 浏览并以 `q` 或 Esc 返回；`/side use <id>` 才把它提升到主上下文。之后也能通过 Research Memory 找回，但它仍属于 assistant synthesis，不是实验事实。

需要当天信息、一个官方页面或一份有界小调研时，可以让 Pi 调用 `web_search`。它复用 Research Pi 配置中的 DeepSeek key。用户明确指定，或任务确实需要大量搜索、交叉核验和中间材料整理时，再交给 Codex 隔离过程。

需要 Codex 实际完成一项较长任务时，可以直接对 Pi 说：

```text
把数据加载重构和完整回归测试交给 Codex executor。目标是消除当前内存峰值，允许它在项目内修改、删除、提交和运行实验。Codex 使用 gpt-5.6-sol/max；你负责给出成功标准，并在它返回后审查证据。若远程运行需要项目外 SSH 凭据，让它返回准确命令给我批准或直接执行。
```

如果问题尚未成熟，希望 Pi 与 Codex 共同讨论而不是让 Codex 评审，可以说：

```text
把这个问题交给 Codex advisor 继续讨论，mission=representation-semantics。现在不要下结论：先确认我们对问题的共同理解，必要时向你提出一个聚焦问题，再展开几个竞争解释并形成可继续修改的 working synthesis。
```

advisor 保持项目只读，但不再默认采取反驳姿态。它可通过 Runtime mailbox 向 Pi 提出会显著改善讨论的问题；Pi 用 `respond` 回答后，同一 Codex turn 继续。后续使用同一 mission 会恢复原 Codex thread，使咨询内容不随 Pi Session 轮换丢失。

Pi 会获得一个 `codex-...` job ID。单个 job 时，底部状态栏持续显示 job 后八位、advisor/executor 模式和明确的 `starting/running/completed/failed/cancelled/outcome_unknown` transport lifecycle；`now:` 表示当前叶子活动，`last:` 表示最近结束的命令或工具。两个以上 Action 或并发叶子活动出现时，footer 只显示不会跳动的聚合计数，Runtime Dock 为每个 Action/活动保留固定多行；超过可见上限时使用 `/watch`。`research_pi_host · completed` 只表示一次工具调用完成，job `completed` 只表示 Codex turn 正常结算；executor 是否完成委派目标由 final result 的 `outcome=succeeded` 且 `goal_satisfied=true` 决定。后台任务未结束时，应查询同一 job 的 status/result，或续接同一 Codex Actor，而不是重复启动任务。状态、阻塞问题和完成事件先进入项目 Runtime mailbox，再交给最近 attached 的 Research Leader session。默认 executor 是 project-write + public-network，advisor 是 project-read + public-network；各自的默认 model/effort 位于 `config.json` 的 `codex.executor` 与 `codex.advisor`，也可以在具体委派时覆盖。

`outcome_unknown` 表示 executor 可能已产生文件、Git、远程 run 等副作用，但 worker 没有留下可靠终态。此时不要重跑或猜测：先检查相关外部状态，再让 Pi 调用 `codex_delegate action=reconcile`，提供 `completed|failed|cancelled` 和简短证据说明。同一 workspace 在结案前不会启动另一写入型 Codex；advisor 仍可用于只读排查。

Codex 中间更新使用自然语言 `phase=commentary`，不再受终态 schema 约束；结束时调用 `submit_research_pi_result` 写入严格结构化结果，再发简短 `phase=final_answer` acknowledgement。结果卡默认折叠为状态、摘要预览和结构化计数；展开后额外显示 delegation outcome、completion basis 与 remaining work。用户可随时运行 `/watch` 查看最近的 active Action，也可用 `/watch <job后缀>`、`/watch <mission>` 或 `/watch @codex:<Actor短码>` 定位。内部 subagent 只是本次 Action 的临时子节点，不会污染 Project Actor 列表。

Pi 在连续处理同一研究子任务时应使用稳定、简短的 `mission` 标签。带 mission 的新派遣默认 `reuse=auto`：运行中的同 mission/mode/track job 会直接重新挂接，已完成的会通过 App Server `thread/resume` 续接历史；同一精确 workspace、mode、mission 和 research track 可跨 Pi session 复用。同一个 advisor mission 用于持续澄清同一问题；换轨后默认开启新 thread，只有用户或 Leader 显式恢复旧 job 才跨 track 续接，并会收到 route-change 警告。续接时 Runtime 也会比较 Git snapshot，工作区变化则要求 Codex 重新检查当前文件。使用 `/codex missions` 查看按 track 分组的任务链，使用 `/actors` 找当前活跃 Actor，或用 `/actors all` 找 suspended Actor 的稳定 `@codex:<Actor短码>`；若要切换研究路线或主动清除旧假设，使用新的 mission。

用户发现某个 Actor 跑偏时可以直接输入：

```text
/steer @codex:12ab34cd 先停止继续补丁；回到 H1/H2 的可区分预测，检查当前实验是否真的介入了目标变量。
```

默认 steer 不终止当前工具批次，而是在下一安全模型边界进入目标上下文。只有错误删除目标、明显错误的昂贵实验或其他继续运行具有实质代价的场景，才使用 `/steer --preempt ...`。`/message reply @codex:12ab34cd ...` 会优先回答该 Actor 当前的 blocking request。消息状态保存在用户状态目录的 project Runtime ledger；它不是科研结论，也不会永久重复注入模型上下文。

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
| 查看 Project Runtime/ProjectView | `/runtime`、`/runtime health`、`/runtime view` |
| 用 Project State 交接到空白 Session | `/runtime rotate [reason]` |
| 新建不带 Project 记忆的 Session | `/runtime new clean [reason]` |
| 让 clean Session 恢复 Project 继承 | `/runtime inherit [reason]` |
| 窄幅纠正当前 Project State | 说明修订依据，让 Leader 调用 `amend_project_state` |
| 查看或持久切换模型 profile | `/model`、`Ctrl+L`；CLI 可用 `pi config use opencode-go-flash` |

科研中推荐这样区分：

- 竞争假设 A/B 仍属于同一问题：使用 `/tree`，保留在同一会话树中；
- 已经切换成新的研究问题或正式实验阶段：使用 `/fork` 或 `/new`；
- 会话很长但仍在解决同一问题：可手动使用 `/compact`。默认在约 272K/384K 总上下文处标记自动压缩，但会等当前 agent run 及其工具调用链完整 settled 后才执行，不会中断正在进行的任务。默认按当前分支第 1/2/3 次 compact 保留约 24K/32K/40K recent tail，结构化摘要目标 8K、生成硬上限 16K，compact 后通常约为 32K/40K/48K；这些数值统一在 `config.json` 的 `research.compaction` 调节。竞争假设、有效性、evidence refs 与下一实验写入结构化 compact，完整 JSONL 历史仍保留。
- 新会话需要恢复旧证据：使用 memory search/read，不必先恢复整个旧 session。
- 普通新 Session 会自动收到基于最近 structured state、实验账本、Git 和 Runtime 的限长 ProjectView；它是导航信息而非证据替代。用 `/runtime view` 可检查来源，用 `/runtime recommend` 可查看是否值得 compact 或轮换。确定交接时优先使用 `/runtime rotate`：它先检查 Project State、未知副作用与 Action 恢复身份，再创建空白 transcript 的 project-aware Session；原生 `/new` 不做这份 readiness/audit。若目的是主动排除项目记忆影响而非接手，则使用 `/runtime new clean`，之后只有显式 `/runtime inherit` 才恢复自动注入。
- ProjectView 显示 `current/unconfirmed/stale/transitioning/missing` freshness。新 experiment 或 research transition 晚于最近 compact 时，旧 claim/next experiment 不再作为当前结论；只有较新的 Action 或 Git 变化时标为 unconfirmed，要求确认但不自动宣布换轨。

方向实质变化时可以直接告诉 Pi：

```text
旧离散契约路线保留为 contract-bound 负结果，但不再是当前默认路线。当前转向参数化连续契约；请记录 research transition，依据是用户决策、对应实验和框架文档，下一决策是 family3 后冻结正式 test 判定线。
```

Transition 会立即影响后续 Session 的 ProjectView，不必等待 `/compact`。下一次 compact 基于 Project revision 形成新的 active state；旧 Session 随后提交的陈旧 compact 不会覆盖它。

从终端恢复最近会话：

```bash
./run-pi.sh -c
```

浏览选择历史会话：

```bash
./run-pi.sh -r
```

## 5. 常用界面操作

输入 `/` 会打开 slash command 补全；Pi 0.84.2 没有单独的 `/help` 命令。Research Pi 隐藏了不再需要的低层 `/scoped-models` 补全项。

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

注意：单次 `Ctrl+C` 是清空编辑器；连续两次才退出。中止运行应使用 `Escape`。`Ctrl+L` 与 `/model` 的已知 profile 选择会持久保存；Shift+Tab 修改的 thinking 也会写回当前 profile。

## 6. 一次性任务和自动化入口

不进入交互界面，执行一次任务后退出：

```bash
./run-pi.sh --approve -p "阅读 README.md，概括项目目标和当前未验证边界"
```

不保存会话的一次性探针：

```bash
./run-pi.sh config show
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
- Research Pi 在约 272K 总上下文时标记 compact，384K 作为硬触发线；当前 agent run settled 后再执行，避免压缩 abort 尚未完成的工具链；原始 recent tail 按当前分支第 1/2/3 次 compact 取约 24K/32K/40K，结构化状态目标 8K，compact 后通常约 32K/40K/48K；
- 当前适合科研探索；极限上下文、长期多分支召回和 Codex 无人值守远程执行仍需在真实任务中继续验证；
- 先让真实任务暴露摩擦，再加入 extension 或工作流，不预先安装全家桶。
