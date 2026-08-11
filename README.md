# Research Pi

Research Pi 是一个面向 AI、通信等计算实验的个人 Pi harness。它使用锁定版本的 Pi Core 和 DeepSeek V4 Flash，并加入科研优先的身份与工作约定、项目级命令边界、持久化 side 对话、DeepSeek 原生网页检索、实验记录、研究 checkpoint、非向量历史检索、结构化科研 compact、Codex 长程执行委派与按需 trace。

## 快速开始

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

安装当前用户的命令入口：

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

安装器默认在 `${XDG_BIN_HOME:-$HOME/.local/bin}` 创建符号链接，不覆盖已经存在的同名文件。

## 默认配置

- Pi Core：`0.84.1`
- Provider：`deepseek`
- Model：`deepseek-v4-flash`
- Endpoint：`https://api.deepseek.com`
- Thinking level：`max`（通过官方 `reasoning_effort: "max"` 启用；384K 是最大输出上限，不是输入上下文或压缩阈值）

主要配置位于：

- `.pi/settings.json`：模型、thinking 和 retry 设置。
- `.pi/agent/settings.json`：在其他科研项目中调用 `pi` 时仍生效的 retry 和 compact 默认值。
- `.pi/agent/models.json`：DeepSeek 请求字段兼容配置。
- `.pi/APPEND_SYSTEM.md`：追加到 Pi 默认提示后的稳定 Research Contract。
- `.pi/extensions/`：Research Pi 提供的工具扩展。

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

### Host capability

当科研任务确实需要读取项目外资料、连接实验服务器或运行会调用 SSH/rsync 的项目脚本时，使用 `host_capability`。授权由用户在 TUI 中选择一次或当前 Pi session（24 小时），Pi 与该 session 启动的 Codex job 共用同一个本地账本：

- `external-read` 只允许一个精确文件，或显式批准目录下的读取；私钥、`.env`、云凭据与 keychain 等不能授权给模型读取；
- `ssh-target` 只允许一个精确 `[user@]host[:port]`，系统 SSH 可以不透明地使用 `~/.ssh/config`、私钥或 `SSH_AUTH_SOCK`，但凭据内容不会进入模型、prompt、job 或日志；
- `project-script` 只允许项目内一个精确 SHA-256 和精确 argv。脚本或参数变化后必须重新批准，适合 `./sync.sh --once` 这类已有工作流；
- Codex advisor 只能使用外部只读授权；executor 才能使用 SSH 和项目脚本。

可以让模型直接调用 `host_capability` 并在弹窗中批准，也可以由用户预先执行：

```text
/boundary grant-read "~/.ssh/config"
/boundary grant-ssh 931server
/boundary grant-script ./sync.sh --once
/boundary grants
/boundary revoke <grant-id|all>
```

`/boundary` 显示当前边界和 grant 数量。授权账本位于本地 `.pi/capabilities/`，不会进入 Git；它只保存目标、scope、到期时间、脚本哈希与 argv，不保存密钥。任意通用 bash 仍处于 project-only 边界，`!` / `!!` 继续作为最后的人工系统权限通道。

直接文件工具访问普通项目外路径时，交互界面会显示请求路径和解析后的真实路径，并可批准一次或本 session；已知凭据材料不能进入模型。shell 越界仍会失败，Pi 应优先请求精确 host capability，无法表达时才把准确 `!` 命令交给用户。用户输入的 `!` / `!!` 是明确的人工直执行通道，不受模型 shell 边界约束。

### Tool Activity

所有模型工具调用都会在 Pi 底部状态栏显示工具名、安全截断后的目标摘要、运行时间和成功/失败终态；并行调用显示当前数量与最近启动的工具。普通工具终态保留 5 秒，`codex_delegate` 的后台 job 另有持久状态，不会因委派工具返回而消失。

### Research Mode

Research Pi 默认处于探索与验证阶段：构造竞争假设，优先高信息增益且可逆的实验，将代码视为实验工具，并在证据支持路线或用户要求稳定交付后才进入收敛工程阶段。完成标准是研究判断得到推进，而不是代码发生修改。

### `record_experiment`

当一次运行会改变后续研究判断时，记录假设、介入、预期、有效性检查、观察与下一步。记录写入目标科研项目的 `.pi/research/experiments.jsonl`，该文件默认不应进入版本控制。

### `research_checkpoint`

在大步实验修改、回滚或废弃路线前，为当前已跟踪 Git 状态创建独立的研究 checkpoint，不切换分支，也不修改工作树。

### Research Memory

`research_memory_search` 和 `research_memory_read` 为模型提供按需历史检索。原始 session JSONL 和实验账本仍是事实源；本地 `.pi/memory/memory.sqlite` 只是可删除、可重建的派生索引。

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

DeepSeek V4 Flash 使用 Max reasoning，但不把 1M 容量等同于等质量注意力。Research Pi 在约 272K 总上下文时发起软 compact，384K 作为硬触发线；压缩后的原始 recent tail 按当前分支第 1/2/3 次 compact 取约 32K/40K/48K，之后固定在 48K。结构化研究状态和可检索历史负责承接更早证据。

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
- `respond` 回答 Codex 在运行中提出的显式问题；`steer` 将修正或新证据注入仍在运行的 turn，不需要终止并重开任务；
- 后台任务会在 Pi 底部状态栏持续显示 job 后八位、模式、运行状态与最近进度；完成、失败、取消或需要输入时，会把一条限长结构化事件送回最初的 Pi session 并自动触发 Leader 继续处理；
- Pi 重启或恢复会话后会按 session ID 重新挂接仍在运行或尚未消费的 job。若输入框中已有草稿，事件排到下一轮，避免抢占用户正在写的内容；
- 不默认建立 worktree，同一目标工作区同时只允许一个写入型 Codex job。

Codex job、请求账本、精简 JSONL 审计事件和委派 prompt 保存在 harness 的 `.pi/codex/`，不会进入 Git。默认不落盘 token delta、reasoning 生命周期或模型正文；`job.json` 仅在可见进度或语义状态变化时更新，并在 `workerIo` 中记录实际写入计数。审计事件和 stderr 每个 job 分别限制为 2 MiB。只有显式设置 `PI_CODEX_TRACE=1` 才记录上限 32 MiB 的原始 App Server event，用完应立即关闭。已经处理的普通响应只保留长度和 SHA-256，不长期保留正文；但响应首先会进入 Pi 模型上下文，因此绝不能通过该通道传递 API key 等秘密。普通 Codex 工具子进程不继承 DeepSeek key，也不能直接访问 SSH agent；只有 `research_pi_host` broker 在匹配用户 grant 后才把 `SSH_AUTH_SOCK` 不透明地交给系统 SSH 进程。Codex CLI 自身仍使用本机 Codex 登录完成模型调用，但该认证不会授予其工具访问用户目录。

### Trace

`pi-traced` 将 trace 写入本 harness 的 `.pi/agent/traces/`。其中可能包含完整 prompt、工具参数和输出；该目录已被 Git 忽略。

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
