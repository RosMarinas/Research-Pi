# Research Pi

Research Pi 是一个面向 AI、通信等计算实验的个人 Research Runtime。它使用锁定版本的 Pi Core 和 DeepSeek V4 Flash，并加入科研优先的身份与工作约定、项目级 Actor/mailbox、项目命令边界、持久化 side 对话、DeepSeek 原生网页检索、实验记录、研究 checkpoint、非向量历史检索、结构化科研 compact、Codex 长程执行委派与按需 trace。

## 开发仓库与稳定安装

本仓库本身是 Research Pi 的快速开发 checkout：修改 extension、policy 或 prompt 后，`./run-pi.sh` 会立即使用新代码，适合持续迭代。`./install-user.sh` 创建的 `~/.local/bin/pi` 只是指向该 checkout 的开发软链接，不属于稳定发布。

稳定版本按 npm CLI 打包，程序代码、用户配置和运行状态彼此分离：

```text
npm 全局目录                  Research Pi 程序与锁定依赖
~/.config/research-pi/        credentials.env 等用户配置
~/.local/state/research-pi/   sessions、project Runtime、memory、Codex jobs、grants、trace
<research-project>/.pi/       该项目自己的实验记录与 checkpoint
```

发布稳定 tag/package 后，安装方式为：

```sh
./install-user.sh --remove-dev-links  # 若此前安装过 checkout 开发软链接
npm install -g @rosmarinas/research-pi
pi setup
pi paths
```

也可从明确的 Git tag 安装而不依赖 npm registry：

```sh
npm install -g 'git+ssh://git@github.com/RosMarinas/Research-Pi.git#v0.2.0'
pi setup
```

`pi setup` 只创建权限为 `0600` 的用户配置模板，不生成或提交密钥。填入 `~/.config/research-pi/credentials.env` 后即可在任意项目运行 `pi`。使用 `pi paths` 可检查当前程序、配置和状态目录；使用 `pi doctor` 可在不调用模型的情况下验证宿主 Git/Python 与 Codex sandbox。

## 从源码快速开发

要求 Node.js `>=22.19`。

```sh
git clone git@github.com:RosMarinas/Research-Pi.git
cd Research-Pi
npm install --ignore-scripts
cp .env.example .env
```

编辑 `.env`，填入 DeepSeek 官方 API key：

```dotenv
DEEPSEEK_API_KEY=你的_API_key
```

可选：安装指向当前 checkout 的开发命令入口：

```sh
./install-user.sh
```

随后可在任意科研项目中直接启动：

```sh
cd /path/to/research-project
pi
```

更完整的命令说明见 [`docs/pi-basic-guide.md`](docs/pi-basic-guide.md)。

## 命令入口

- `pi`：加载 Research Pi harness。
- `pi-traced`：额外记录模型、工具与时延 trace；trace 可能包含敏感内容，仅按需使用。
- `pi-raw`：直接运行锁定的 Pi Core，用于与 harness 行为进行对照。

开发安装器默认在 `${XDG_BIN_HOME:-$HOME/.local/bin}` 创建符号链接，不覆盖已经存在的同名文件。移动或删除 checkout 会使该开发入口失效；稳定使用应安装打包版本。

## 默认配置

- Pi Core：`0.84.1`
- Provider：`deepseek`
- Model：`deepseek-v4-flash`
- Endpoint：`https://api.deepseek.com`
- Thinking level：`max`（通过官方 `reasoning_effort: "max"` 启用；384K 是最大输出上限，不是输入上下文或压缩阈值）

源码开发模式的 Harness 配置位于：

- `.pi/settings.json`：模型、thinking 和 retry 设置。
- `.pi/agent/settings.json`：在其他科研项目中调用 `pi` 时仍生效的 retry 和 compact 默认值。
- `.pi/agent/models.json`：DeepSeek 请求字段兼容配置。
- `.pi/APPEND_SYSTEM.md`：追加到 Pi 默认提示后的稳定 Research Contract。
- `.pi/extensions/`：Research Pi 提供的工具扩展。

打包模式会在启动时把经过审查的 `models.json` 和 `settings.json` 部署到用户状态目录；API key、session、memory、trace、Codex job 和 capability ledger 不写入 npm 安装目录。

运行其他科研仓库时，该仓库自身的 `AGENTS.md` 等项目上下文仍会正常加载。

最终 system prompt 由 Pi 原生的动态工具说明、Research Contract、目标项目上下文、白名单 skill 与当前工作目录共同构成。`research-mode` 扩展只把原生的 “coding assistant” 身份句稳定替换为 “computational research agent”；它不覆盖动态工具说明，也不在每轮加入时间、状态或随机内容。如果目标项目提供自定义 `SYSTEM.md`，该身份替换不会擅自改写它。

## Skill 白名单

启动器使用 Pi 原生的 `--no-skills` 关闭全局和项目 skill 自动发现，再通过 `--skill` 只加载经过检查的默认白名单：

- `~/.agents/skills/cognitive-knowledge-network`：研究概念、方法和证据导航；
- `~/.codex/skills/remote-workspace`：远程环境、实验和 GPU 执行。

其他 skills 不会因为存在于 `~/.agents/skills/`、`.agents/skills/` 或 `.pi/skills/` 而自动进入上下文。需要临时启用时，仍可使用 Pi 原生命令行参数：

```sh
pi --skill /path/to/skill
```

白名单 skill 在当前机器不存在时会被跳过并给出提示，不影响 Pi 启动。

同理，启动器使用 `--no-extensions` 关闭目标项目和用户目录中的可执行 extension 自动发现，只显式加载本仓库审查过的 harness extensions。需要临时加载目标项目 extension 时必须由用户在启动命令中明确传入 `--extension /path/to/extension.ts`；这属于宿主代码执行授权，不受模型 shell 沙箱保护。

## 科研扩展

### Project Boundary

模型发起的 shell 使用 Pi 官方示例采用的 sandbox runtime，在 macOS 上落到 Seatbelt、Linux 上落到 bubblewrap/seccomp；Codex executor 使用 Codex permission profile。两者默认只能读取必要的系统运行路径，并可读写当前科研项目。项目内允许大步修改、删除和自由 Git commit；Git objects、index、refs 与 config 可写，`.git/hooks` 保持只读。Harness 只从用户级 Git 配置提取 `user.name` / `user.email` 注入提交环境，不暴露其余全局 Git 配置。普通 Web 客户端通过开放审批代理访问公网；OpenSSH 这类原始 TCP 客户端必须使用下面的显式 host capability。Unix socket、宿主凭据与其他目录不会自动继承。

macOS 启动时由可信宿主侧解析活动的 `xcode-select -p`，将该 Developer 目录只读加入 Pi/Codex 的共享系统运行时策略，并显式设置 `DEVELOPER_DIR`。因此 `/usr/bin/git`、系统 Python 和编译工具不需要读取整个用户目录。每个 Codex job 在模型执行前先运行无模型 sandbox preflight；Git 或系统运行时不可用时立即失败，不消耗模型调用。可随时执行：

```text
/boundary doctor
```

或在终端执行：

```sh
pi doctor --workspace /path/to/research-project
```

### Host capability

普通 `uv`、Python、shell、Node、Git 和测试命令在项目 sandbox 内直接运行，不按命令名称或 `-c` 字符串做白名单判断。当科研任务确实需要读取项目外资料、连接实验服务器，或让项目命令使用宿主 SSH/config/agent 等权限时，使用 `host_capability`。授权有三种作用域：一次、当前 Pi session（24 小时）和当前项目持久信任；Pi 与 Codex job 共用同一组规则：

- `external-read` 只允许一个精确文件，或显式批准目录下的读取；私钥、`.env`、云凭据与 keychain 等不能授权给模型读取；
- `ssh-target` 只允许一个精确 `[user@]host[:port]`，系统 SSH 可以不透明地使用 `~/.ssh/config`、私钥或 `SSH_AUTH_SOCK`，但凭据内容不会进入模型、prompt、job 或日志；
- `host-command` 以 `shell:false` 执行明确 argv，工作目录必须位于当前项目。一次/session 授权匹配完整 argv；项目信任匹配界面显示的结构化前缀，例如 `uv run remote_run.py`、`python3 remote_run.py` 或 `./sync.sh`，因此实验参数可以变化而无需反复批准；
- `sh -c`、`bash -c`、`python3 -c`、`node -e` 等代码字符串默认只建议把完整 argv 作为持久规则，不会退化成信任整个解释器；
- `project-script` 保留为兼容用的最严格模式：绑定项目内文件的精确 SHA-256 与精确 argv；
- Codex advisor 只能使用外部只读授权；executor 可复用项目认可的 SSH target 和 command prefix。

可以让模型直接调用 `host_capability` 并在弹窗中批准，也可以由用户预先执行：

```text
/boundary grant-read "~/.ssh/config"
/boundary trust-ssh 931server
/boundary trust-command uv run remote_run.py
/boundary trust-command python3 remote_run.py
/boundary trust-command ./sync.sh
/boundary grant-command python3 -c "print('one exact host-side probe')"
/boundary grant-script ./sync.sh --once
/boundary grants
/boundary revoke <grant-id|all>
```

`/boundary` 显示当前边界和 grant 数量。`grant-*` 是当前 session 规则，`trust-*` 是按项目根目录隔离的持久规则；两者都可随时 revoke。授权账本位于当前状态目录的 `capabilities/`（源码开发模式即 Git 忽略的 `.pi/capabilities/`），不会打包或进入 Git；它只保存项目哈希、目标、scope、到期时间、argv 前缀及兼容脚本哈希，不保存密钥。

`host-command` 是显式离开 sandbox 的宿主执行：它继承用户账号可用的运行时环境与 SSH agent，因此比不透明 `ssh-target` 更强。界面会同时显示完整 argv、cwd 和建议持久前缀，只有用户授权后才能执行。shell sandbox 越界时，Pi 应优先通过该 broker 申请一次或项目规则并继续当前任务；只有 broker 无法表达操作时才退回人工 `!` / `!!` 通道。

### Tool Activity

所有模型工具调用都会在 Pi 底部状态栏显示工具名、安全截断后的目标摘要、运行时间和成功/失败终态；并行调用显示当前数量与最近启动的工具。普通工具终态保留 5 秒，`codex_delegate` 的后台 job 另有持久状态，不会因委派工具返回而消失。

运行 `/watch` 可按需打开紧凑的 Codex 执行 overlay；它不会长期占据编辑区。`←/→` 切换当前项目可见的 Codex Action，`Tab` 或 `↑/↓` 在 overview、activity、agents 三个视图间切换，`r` 刷新，`q`/`Esc` 关闭。agents 视图展示当前 Action 内部 subagent 的 thread、路径、状态、模型和最近消息。面板直接读取脱敏的 App Server 客观事件，展示命令、退出码与限长输出尾部、文件修改、MCP/动态工具、搜索以及 Codex 内部 subagent 状态；不会经过 Research Leader 转述，也不会进入 DeepSeek 上下文。

### Research Mode

Research Pi 默认处于探索与验证阶段：构造竞争假设，优先高信息增益且可逆的实验，将代码视为实验工具，并在证据支持路线或用户要求稳定交付后才进入收敛工程阶段。完成标准是研究判断得到推进，而不是代码发生修改。

### `record_experiment`

当一次运行会改变后续研究判断时，记录假设、介入、预期、有效性检查、观察与下一步。记录写入目标科研项目的 `.pi/research/experiments.jsonl`，该文件默认不应进入版本控制。

### `research_checkpoint`

在大步实验修改、回滚或废弃路线前，为当前已跟踪 Git 状态创建独立的研究 checkpoint，不切换分支，也不修改工作树。

### Research Memory

`research_memory_search` 和 `research_memory_read` 为模型提供按需历史检索。原始 session JSONL 和实验账本仍是事实源；状态目录中的 `memory/memory.sqlite` 只是可删除、可重建的派生索引。

- 使用 SQLite FTS5，不使用 embeddings 或向量数据库；
- 中文使用 trigram，短 run ID 使用受限子串回退；
- 默认只检索当前 Git 项目，排除当前 session 和废弃分支；
- 实验记录、用户陈述、助手综合和 compact 摘要带有不同 reliability；
- 常见 API key、token 和 password 形式在写入索引前会脱敏，但原始 session 本身仍应视为敏感数据。

人类可使用 `/memory <query>` 查看前三条结果；该命令不把结果加入模型上下文。它不会自动在每轮注入旧会话。

### Side 对话

`/side <问题>` 使用当前可见上下文发起一次隔离调用，并把完整问答保存为 session custom entry。它不会自动进入后续主对话上下文，因此适合临时追问、替代解释和有价值但暂时不应污染主线的想法。

- 卡片折叠时显示问题和答案预览，`Ctrl+O` 展开完整 Markdown；
- `/side list` 列出当前会话分支的 side 对话；
- `/side show <id>` 单独查看完整内容；
- `/side use <id>` 显式把选中的问答提升到主上下文；
- side 内容会进入 Research Memory，可靠性按 assistant synthesis 处理。

### Web Search

`web_search` 通过 DeepSeek Anthropic-compatible API 的原生 Web Search 做简单、直接、带结构化来源的当前信息检索，复用同一个 `DEEPSEEK_API_KEY`，无需额外搜索服务密钥。若 API 没有返回结构化来源，工具会明确标为未核验模型综合。

Pi 可直接完成有界的小型调研；当用户指定，或任务确实需要大量搜索、交叉核验和中间材料整理时，再交给 Codex 隔离过程。

### Research Compaction

DeepSeek V4 Flash 使用 Max reasoning，但不把 1M 容量等同于等质量注意力。Research Pi 在约 272K 总上下文时标记软 compact，384K 作为硬触发线；真正压缩只在当前 agent run（包括工具调用链）完整 settled 后开始，不会为压缩 abort 尚未完成的科研任务。压缩后的原始 recent tail 按当前分支第 1/2/3 次 compact 取约 32K/40K/48K，之后固定在 48K。结构化研究状态和可检索历史负责承接更早证据。

`/compact` 或自动 compact 时，扩展同时生成：

- 给模型继续工作的科研状态摘要；
- 存在 compaction entry `details` 中的结构化 `researchState`、evidence ledger 和 provenance。

强结论必须引用有效的 `record_experiment` entry；仅引用无效或 inconclusive 运行的 supported/weakened/rejected 状态会被降级。模型输出不能解析或校验时，自动回退到 Pi 原生 compact。使用 `/research-state` 可检查最近一次结构化状态。

### Codex Executor

`codex_delegate` 将本地 Codex CLI 作为上下文隔离的执行器或顾问，Pi 继续负责研究问题、假设、证据判断和下一步决策。

- `advisor`：只读分析，默认 `gpt-5.6-sol`、reasoning `max`；
- `executor`：完整执行任务，默认 `gpt-5.6-sol`、reasoning `max`、自动使用 project-write permission profile；
- 每次调用都可覆盖 Codex model 和 reasoning effort；
- executor 可在项目内修改或删除文件、安装项目依赖、自由提交，以及启动或取消昂贵实验；经过用户授权后，它还可通过 `research_pi_host` 使用精确外部只读、SSH target 和固定脚本，不需要复制凭据或重开 delegation；
- Codex 通过本地 stdio App Server 运行，保存稳定的 thread/turn ID；长任务默认后台运行，通过同一个工具的 `status`、`result`、`respond`、`steer`、`resume` 和 `cancel` action 管理；
- 连续处理同一研究子任务时，Pi 会给它稳定的 `mission` 标签并使用 `reuse=auto`：mission 对应一个 project Codex Actor，同一精确 workspace、mission 和 advisor/executor mode 可跨 Pi session 续接原 thread。独立批判、新研究路线或另一 worktree 会创建新 Actor/thread；不能仅因属于同一仓库就混用上下文；
- `/codex missions` 查看当前 project workspace 的 mission/thread 链。新 job 由 `projectKey + research-leader Actor` 所有，不再绑定一个 conversation branch；文件操作仍强制绑定原精确 workspace。续接前会比较上次终态与当前 Git snapshot，变化时要求 Codex 重新检查；
- `respond` 回答 Codex 在运行中提出的显式问题；`steer` 将修正或新证据注入仍在运行的 turn，不需要终止并重开任务；
- 后台任务会在 Pi 底部状态栏持续显示 job 后八位、模式、运行状态与最近进度；完成、失败、取消或需要输入时，限长结构化事件进入 project Runtime mailbox，只交给当前 attached Research Leader session；
- Codex worker 与 Pi TUI 解耦：直接退出 Pi 不会取消正在运行的后台 Codex，之后重新进入同一 workspace 即可查看结果或继续通信；需要停止任务时显式使用 `cancel`；
- `/watch [job后缀|mission|@codex:<Actor短码>]` 直接查看 executor 或 advisor 当前 Action 的客观执行；Codex 内部临时 subagent 作为 Action 子节点展示，不自动注册成长期 Project Actor；
- 新开或恢复 Pi session 会 attach 到同一 project Research Leader Actor；最近收到用户输入的 session 成为当前接收者。消息先 durable queue，再进入一次模型上下文，settled 后不在后续 turn 反复注入。输入框中已有草稿时事件排到下一轮；
- 不默认建立 worktree，同一目标工作区同时只允许一个写入型 Codex job。

Codex job、请求账本、精简 JSONL 审计事件和委派 prompt 保存在状态目录的 `codex/`（源码模式即 `.pi/codex/`）；Actor、Action 与 mailbox 的稀疏语义事件保存在 `runtime/projects/<projectKey>/events.jsonl`（源码模式即 `.pi/runtime/`），两者都不会进入 Git。Runtime 不记录 token delta、heartbeat 或完整 conversation，并在物理追加前按确定性 event ID 去重。Codex `job.json` 仅在可见进度或语义状态变化时更新，并在 `workerIo` 中记录实际写入计数。`/watch` 增量读取已有审计流，不额外记录 token delta 或创建另一份高频 trace。审计事件和 stderr 每个 job 分别限制为 2 MiB；命令输出只保留限长尾部并对常见凭据模式整体遮蔽。Research Pi 默认抑制 Codex App Server 写入 `logs_*.sqlite` 的内部 TRACE/DEBUG 反馈日志，但保留 `state_*.sqlite` 的 thread/runtime 状态；只有排查 Codex 上游问题时才应显式设置 `PI_CODEX_SQLITE_LOGS=1` 恢复内部日志，用完立即关闭。该设置不会删除此前已经积累的日志。只有显式设置 `PI_CODEX_TRACE=1` 才记录上限 32 MiB 的原始 App Server event，用完也应立即关闭。已经处理的普通响应只保留长度和 SHA-256，不长期保留正文；但响应首先会进入 Pi 模型上下文，因此绝不能通过该通道传递 API key 等秘密。普通 Codex 工具子进程不继承 DeepSeek key，也不能直接访问 SSH agent；只有 `research_pi_host` broker 在匹配用户 grant 后才把 `SSH_AUTH_SOCK` 不透明地交给系统 SSH 进程。Codex CLI 自身仍使用本机 Codex 登录完成模型调用，但该认证不会授予其工具访问用户目录。

### Project Runtime（第一阶段）

当前只注册 `user`、`research-leader` 和 Codex mission Actors，不引入自动 Scheduler 或固定科研流程：

- `/actors` 或 `/actors active`：只查看当前 running/starting/cancelling/waiting 的 project Actors；`/actors all` 才显示历史注册和 suspended Actors。底部 Runtime 状态同样只显示 active/waiting/idle，不再把历史注册总数冒充活跃数；
- `/inbox`：查看尚未投递的 durable 消息；`/inbox all` 查看最近状态；
- `/message <ask|reply|notify|result> @actor <内容>`：向 Actor 发送有语义类型的消息；
- `/steer @actor <修正>`：默认不 abort，投递到下一安全模型边界；
- `/steer --preempt @actor <修正>`：只有继续运行存在实际代价时才中断并恢复目标 Actor。

Runtime message 是瞬时控制/通信，不自动成为长期科研判断。实验结论仍由 `record_experiment` 与后续 ProjectView 承接。旧版本已经创建的 Codex job 保留原 session/branch 所有权；新 job 才使用 project Actor 所有权。

职责、状态机、通信路径以及双 Session 真实项目 smoke 的逐项判定见 [Research Runtime 测试指南](docs/research-runtime-test-guide.md)。

### Trace

`pi-traced` 将 trace 写入状态目录的 `agent/traces/`（源码模式即 `.pi/agent/traces/`）。其中可能包含完整 prompt、工具参数和输出；源码状态目录已被 Git 忽略，稳定包状态目录位于 checkout 之外。

## 不安装全局入口

也可以显式指定目标科研项目：

```sh
/path/to/Research-Pi/run-pi.sh --workspace /path/to/research-project
```

按需 trace：

```sh
/path/to/Research-Pi/run-pi-traced.sh --workspace /path/to/research-project
```

## 敏感信息

`.env`、认证信息、session、memory index、trace 和本地实验记录均被排除在版本控制之外。仓库只跟踪不含真实密钥的 `.env.example`，以及经过审查且不含凭证的模型/运行设置。提交前检查规则见 [`SECURITY.md`](SECURITY.md)。
