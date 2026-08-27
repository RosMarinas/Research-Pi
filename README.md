# Research Pi

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

## 我最喜欢的设计：双 Session 工作流

Research Pi 可以同时开两扇窗口：一边让 **Pi Leader** 安静推进实验，另一边在 **Pi-analysis** 里随时追问、质疑和展开想法。

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

要求 Node.js `>=22.19`。

```sh
npm install -g 'git+https://github.com/RosMarinas/Research-Pi.git#main'
pi setup
pi paths
```

根据 `pi paths` 给出的 `credentialsPath` 填写至少一个供应商密钥：

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
| ProjectView | 将 structured state 与最新 evidence delta 追加到模型上下文，避免旧状态冒充当前结论 |
| Research Memory | 对历史 Session 和实验记录做本地全文检索，不依赖向量数据库 |
| Research Compaction | 在模型 settled 后生成带 provenance 的结构化状态，而不只摘要聊天文本 |
| Experiment Records | 用 `record_experiment` 区分观察、有效性和解释；支持换轨与窄幅状态修订 |
| Codex Collaboration | 以可续接 mission 调用 advisor/executor，并通过 Runtime mailbox 与 Pi 通信 |
| Project Boundary | 默认把模型命令限制在当前项目；SSH、外部文件和宿主命令通过显式 capability 授权 |
| Research Briefing | 在重大结果或阶段交接时恢复工作脉络，并把内部术语翻译成用户可判断的报告 |

ProjectView 使用 append-only snapshot/delta：研究 revision 或 Git identity 改变时，下一用户轮只在 Session 尾部追加更新；同一轮中新产生的 evidence 由 `context` hook 临时补到下一次模型调用尾部。旧 ProjectView 不会反复删除和搬位，因此更利于 DeepSeek 等 provider 复用共同前缀，同时避免陈旧 compact 污染当前判断。

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
| `/model` | 切换并持久化 Leader Session 模型 |
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

实际路径以 `pi paths` 为准。常用配置命令：

```sh
pi config show
pi config list
pi config use opencode-go-flash
pi --profile deepseek-pro
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

## 文档

- [基本使用指南](docs/pi-basic-guide.md)
- [统一配置说明](docs/configuration.md)
- [Project Runtime 测试与恢复](docs/research-runtime-test-guide.md)
- [安全模型与本地数据](docs/security-model.md)
- [设计思想](thesis/ResearchPi.pdf)



## License

Research Pi 的原创代码与文档采用 [MIT License](LICENSE)。第三方组件保留各自许可证，详见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
