# UI / runtime 分离：OpenCode、Claude Agent SDK 与 ACP 官方资料核查

研究日期：2026-10-06。范围限定为官方文档、官方仓库源码和官方协议规范；没有使用 issue、博客或第三方实现来支撑结论。文中的“保证”指文档/规范明确要求或承诺；“源码观察”指当前官方仓库 `dev/main` 分支的实现；“推断”是由前两者得到的架构含义，不把它写成产品保证。

## 结论摘要

三者把“运行时”和“界面”拆开的方式不同：

| 系统 | 进程所有权 | 主要传输 | 历史/恢复 | 适合的 UI 形态 | 关键边界 |
|---|---|---|---|---|---|
| OpenCode server + SDK | `opencode serve` 是独立 runtime；TUI 是 client；SDK 也可启动并拥有 server | HTTP/OpenAPI + SSE；另有内嵌 SDK（内存 router，无监听） | server 暴露 session/message/fork 等 API；SSE 是 live bus stream | 多个 HTTP client、Web、IDE、TUI | 官方只保证 SSE live stream；当前 handler 没有 event id/replay 语义，重连必须重新拉取状态（源码推断） |
| Claude Agent SDK | 宿主应用拥有 SDK；SDK 为每个 session 启动并监督一个 Claude CLI 子进程 | SDK 与 CLI 通过 stdio；宿主应用自行提供 HTTP/WebSocket | 本地 JSONL transcript；`resume`/`continue`/`fork`；`SessionStore` 可镜像到外部存储 | 宿主应用自建 Web、移动端或桌面 UI | 没有 SDK 自带的多 UI 事件 broker；`canUseTool` 是宿主回调，UI 断开时可能让 agent 一直等待 |
| ACP | Client 启动 Agent 子进程；一个连接可承载多个 session | JSON-RPC 2.0 over newline-delimited stdio；Streamable HTTP 仍是草案 | v1 `load` 可回放、`resume` 不回放；v2 `session/resume` + 可选 `replayFrom` | 编辑器/桌面/TUI 等 Client | 是互操作协议，不是 daemon、会话 broker 或 UI 实现；没有标准化“多个 Client 订阅同一 session” |

因此，对 Research Pi 的直接含义是：把每个 workspace 的 `AgentSessionRuntime` 放在独立 daemon 中，由 daemon 负责进程生命周期、session/history、事件序号和 approval/question 状态；本地 UI 走 Unix socket，Web UI 走 gateway。OpenCode 的 HTTP/SSE 形状可作为参考，但不能把其 SSE 当作无损事件日志；Claude SDK 和 ACP 更适合作为 daemon 内的 engine/adapter，而不是让每个 UI 直接拥有 SDK 或 ACP 子进程。

## OpenCode：server 是 runtime，TUI/SDK 是 client

### 官方保证

官方 server 文档明确说，`opencode serve` 启动 headless HTTP server；默认监听 `127.0.0.1:4096`，可配置 hostname、port、CORS，并可用 `OPENCODE_SERVER_PASSWORD` 开启 HTTP Basic Auth。普通 `opencode` 同时启动 TUI 和 server，TUI 通过 server 工作；文档直接把这种结构描述为支持多个 client 和程序化访问。已有 TUI server 也可以由其他 client 通过 hostname/port 连接，`/tui` endpoint 用于驱动 TUI。见 [OpenCode Server](https://docs.opencode.ai/docs/server/)。

官方 JS SDK 有两种所有权模式：[网络 SDK](https://docs.opencode.ai/docs/sdk/) 的 `createOpencode()` 会启动 server 和 client；`createOpencodeClient({ baseUrl })` 只连接已有 server。文档还说明 SDK 类型由 server 的 OpenAPI 规范生成。新版 [embedded SDK](https://opencode.ai/v2/docs/build/sdk) 则把 server router 装在应用内存中，不开 HTTP listener，由 `OpenCode.create()` 返回显式拥有的 host，调用者负责 `close()`；它适合单进程嵌入，不能直接替代跨进程 daemon。

server 的 session/message API 已给出比较完整的 runtime 控制面：列出、创建、读取、删除、fork、abort、share、summarize、revert session；列出/发送消息，且有同步 `POST /session/:id/message` 和异步 `POST /session/:id/prompt_async`。这是“可编程 session 控制面”的保证；文档没有把它表述为跨主机 durable store，因此不应仅凭这些 endpoint 推断重启或迁移后的持久性。见 [Server API 表](https://docs.opencode.ai/docs/server/) 和 [当前 v2 HttpApi](https://dev.opencode.ai/v2/docs/api/)。

权限由 `allow`、`ask`、`deny` 规则控制；工具文档明确包含 `question` 工具，问题可带标题、问题文本、选项和自定义答案。当前 v2 API（页面标为 experimental）列出 pending permission 的 list/get/reply，以及 pending question 的 list/reply/reject。见 [Permissions](https://docs.opencode.ai/docs/permissions/)、[Tools](https://docs.opencode.ai/docs/tools/) 和 [v2 question/permission API](https://dev.opencode.ai/v2/docs/api/)。

### 事件、重连与多个 UI

官方 server 文档保证 `GET /event` 是 SSE；连接后的第一个事件是 `server.connected`，之后是 bus events；另有 `/global/event`。这足以让 Web/IDE/TUI 订阅当前运行状态。

**源码观察（当前 `dev`，不是抽象协议保证）：** [官方 event handler](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/event.ts) 先生成 `server.connected`，再把 `EventV2.allBounded(events, 256)` 接到 SSE，并合并 15 秒 heartbeat。`eventData()` 明确把 SSE `id` 设为 `undefined`；handler 没有 `Last-Event-ID`、cursor 或历史事件查询分支。因而可得到以下谨慎推断：

- SSE 订阅是 live bus stream，不是带游标的 append-only event log；
- 浏览器或 UI 重连后，官方没有保证补发断线期间的每一条 event；
- client 应在重连后重新拉取 session、message、status、pending permission/question，再把后续 SSE 当作增量通知。

这不是说 server 一定丢失 session 数据，而是说“事件连接恢复”与“session 数据恢复”是两个不同问题。官方 API 提供后者的查询面，当前 event handler 没有前者的 replay 语义。

文档说支持多个 client，但 approval/question 是共享的可变 runtime 状态。源码中的 [permission service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts) 以 pending `Map` 保存请求；`reply()` 找到请求后立即删除，再唤醒等待中的执行。由此推断：多个 UI 可以同时观察同一 session，但一个 approval/question 不能被当作“每个 UI 各自消费”；应由 daemon/gateway 做单次决策并向所有 UI 广播结果。文档没有提供 lease、owner、claim 或多 UI 仲裁保证。

### 取舍

OpenCode 最接近“长驻 runtime + 多 UI”：HTTP API、SSE、session 查询和独立 server 已经存在。代价是 client 必须自己做重连后的 snapshot/re-fetch，且 UI 之间共享权限状态，需要明确 first-valid-reply 规则。内嵌 SDK 可以减少本机网络 hop，但 host 生命周期与调用进程绑定，不能解决 UI 进程退出后的 runtime 常驻，也不提供跨进程 fan-out。

## Claude Agent SDK：宿主拥有子进程，历史用于恢复

### 官方保证

Anthropic 的 Agent SDK overview 明确把它定义为“嵌入由你运行的 Python/TypeScript 应用”的库；它会运行 Claude Code binary，并提供 built-in tools、permissions、sessions、hooks。见 [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)。

更具体的进程模型在 [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)：SDK 调用 `query()` 时启动独立 `claude` CLI 子进程，使用 stdio 通讯；子进程拥有 shell、working directory 和本地 JSONL session transcript。官方明确写出“一条 agent session 对应一个 subprocess”，并且 N 个并发 session 对应 N 个 subprocess。子进程本身不监听网络；若需要 Web/移动端入口，宿主应用要自己暴露 HTTP 或 WebSocket，再在内部调用 SDK。

session 是 SDK 自动累积的 prompt、tool call、tool result 和 response 历史，默认写入 `~/.claude/projects/`。官方 [session guide](https://code.claude.com/docs/en/agent-sdk/sessions) 区分：`continue` 找当前目录最近 session，`resume` 用指定 session ID，`fork` 复制历史生成新 session；fork 复制的是对话历史，不复制或隔离 filesystem。默认本地文件只在当前机器上可用。

跨主机/无状态容器的官方方案是 [SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)：SDK 调用 `append` 镜像 transcript，调用 `load` 为 `resume`/`continue` 读回；该 store 只覆盖 transcript，不自动覆盖 `CLAUDE.md` 或 working-directory artifacts。这个设计给了“历史恢复”明确接口，但没有把文件系统、工具副作用或正在运行的 turn 变成可迁移状态。

### 事件、重连与 approval/question

官方 [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) 说明 streaming input 是长生命周期、交互式 session：可排队消息、interrupt、实时反馈和上下文连续性。官方 [Streaming Output](https://code.claude.com/docs/en/agent-sdk/streaming-output) 说明输出是 SDK 暴露给宿主的 async stream，可选择 partial message。这里的“stream”是宿主持有的 SDK iterator，不是一个供多个 UI 订阅的网络事件总线。

**官方文档没有保证 SDK 自带的网络重连、事件游标、多个 UI fan-out 或活动 turn 的无损回放。** 结合“子进程由宿主拥有”和“`resume` 读取持久 transcript”两项保证，较稳妥的解释是：UI 断开后，宿主仍需保留 SDK client/iterator 或主动记录事件；重新连接 UI 时，可从宿主自己的事件缓存恢复视图，或在 turn 结束/进程重启后用 session ID resume 历史。不能把 `resume` 当作“重放断线期间所有实时 token”的保证。

approval 与 clarifying question 都进入宿主传入的 `canUseTool` callback；[官方 user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input) 明确说 callback 会暂停执行直到返回，甚至可以无限等待。`AskUserQuestion` 也通过同一 callback 到达，应用负责把问题和选项显示给用户并返回答案。若用户可能长时间不响应，官方建议用 `PreToolUse` hook 返回 `defer`，让进程退出，之后从持久 session 恢复。由此可见，远程 UI 不能直接“接管” SDK 的 callback；必须由宿主把 pending request 转成自己的可恢复状态，并将一次决策路由回原 session owner。

### 取舍

Claude Agent SDK 的优势是 agent loop、工具、权限和 session context 已经由 Claude Code 提供，适合在 daemon 内按 workspace/session 启动隔离子进程。它的边界也很清楚：SDK caller 是 runtime owner，宿主必须自行实现 HTTP/WebSocket、事件持久化、断线重连、权限通知和多 UI 仲裁。若每个 UI 直接调用 `query()`，就会得到多个独立子进程/历史视图，而不是一个共享 runtime。

## ACP：互操作协议，不是 runtime daemon

### 进程和传输

ACP 官方架构把 Client 描述为编辑器或其他 UI，把 Agent 描述为执行工作的程序；连接时由 editor 按需启动 agent subprocess，通信走 stdin/stdout；一个连接可以支持多个并发 session，Agent 用 JSON-RPC notifications 向 UI 流式报告更新，也可反向请求 permission。见 [ACP Architecture](https://agentclientprotocol.com/get-started/architecture)。

v1/v2 transport 文档都把 stdio 定为当前主要机制：Client 启动 Agent 子进程，双方交换换行分隔的 JSON-RPC；允许 custom transport，但实现者必须自己记录连接建立方式和生命周期。Streamable HTTP 在两版页面上都仍写作 draft/in discussion。见 [ACP v1 Transports](https://agentclientprotocol.com/protocol/v1/transports) 与 [ACP v2 Transports](https://agentclientprotocol.com/protocol/v2/transports)。因此 ACP 本身不能作为“标准远程 daemon transport”来依赖；远程 Web UI 需要自建 proxy/gateway 或采用尚未稳定的传输草案。

### session、历史回放与恢复

ACP v1 的 [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) 要求先 `initialize`；`session/new` 创建 session。`session/load` 只有在 Agent 宣布 `loadSession` capability 时可用，并且 Agent 必须在响应前以 `session/update` 回放完整会话；`session/resume` 是另一条可选能力，恢复上下文但**不得**回放历史。两者都必须由 Client 根据 capability 选择。

ACP v2（当前官方页面标为 draft，见 [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)）把 `session/resume` 作为 session surface 的基线：默认恢复上下文不回放；传 `replayFrom: { type: "start" }` 才回放所有 retained history。规范还明确 Agent 不必永久保留每条插入的 user message，`session/prompt` 成功只确认已插入，不保证未来一定能在 history replay 中看到。见 [ACP v2 Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup)。

这给出一个重要区分：ACP 的 replay 是 Agent 按 session history 提供的重建机制，不是 TCP/SSE 层的 event cursor。断开后若要恢复 UI，应重新建立 ACP connection、initialize，再按 v1/v2 规则 resume/load；断线期间的 live notification 只有在 Agent 将其作为 retained session history 保存时才可能通过 replay 得到。

### approval、question 与多个 Client

ACP v1 的 [Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) 允许 Agent 调用 `session/request_permission`，Client 展示选项并返回用户决定；工具执行由 Agent 负责。v2 将 permission prompt 文本、tool-call subject 和 options 分开，并明确“允许选项授权 Agent 执行 command，不要求 Client 代为执行”。见 [ACP v2 Tool Calls](https://agentclientprotocol.com/protocol/v2/tool-calls)。结构化用户输入另有 elicitation 能力。

**推断边界：** ACP 保证“一个 Client-Agent 连接可以有多个 session”，但没有定义多个独立 Client 同时附着同一 session 的订阅、事件 fan-out、approval lease 或 UI ownership。stdio 的进程拓扑甚至天然是“一个 Client 持有一个 Agent 子进程的 stdin/stdout”。所以 ACP 适合作为 daemon 的外部 adapter；若要让 TUI、Web 和手机同时观察/控制同一运行时，仍需一个上层 broker 负责 session 权威状态、事件广播和 approval 仲裁。

## 对 Research Pi 的可编码建议

以下是结合上述证据的设计建议，不是三套系统的官方承诺：

1. **runtime owner**：每个 workspace 一个独立 daemon，daemon 持有 Pi 1.0 `AgentSessionRuntime`、模型/工具权限和活动 turn。UI attach/detach 不结束 runtime；显式 stop 才结束。Claude SDK 如需接入，在 daemon 内“一 session 一 subprocess”；ACP 如需接入，作为同一 daemon 的 adapter。
2. **双层传输**：本机 UI 使用 Unix socket；Web UI 通过 gateway 转发同一 session。不要让 Web 页面直接拥有 SDK callback，也不要让多个 UI 各自启动 Agent。
3. **权威状态 + 事件日志**：提供 `session snapshot/history/status`，以及带单调 `seq` 的 append-only event stream。客户端重连带 `lastSeq`；可回放则补发，发生 gap 则先发 snapshot/history，再恢复 live stream。这样补上 OpenCode SSE、Claude SDK iterator 和 ACP stdio 都没有统一保证的部分。
4. **approval/question**：pending request 必须是 daemon 的 session 状态，具备 list/get/reply；所有 UI 只显示并提交一次，daemon 以 request ID 做 first-valid-reply 仲裁，然后向所有订阅者广播 accepted/rejected。若 UI 断开，request 仍保留；超时策略另行定义。
5. **历史与副作用分开**：transcript/session history 可恢复不等于文件系统、PTY、正在运行的命令或模型 turn 可迁移。恢复协议应分别返回 session history、当前 runtime status、pending approvals 和 artifact/worktree 状态。
6. **ACP 的定位**：实现 v1 adapter 以接入编辑器生态；对 v2 的 `replayFrom` 可预留，但不要把当前 draft 或 draft 的 HTTP/WebSocket transport 当作 Pi daemon 的基础依赖。native Pi RPC 可作为 engine adapter；没有证据表明它自动提供跨 UI 的 session broker 或可替换的 TUI UI factory。

## 主要原始来源

- OpenCode：[server](https://docs.opencode.ai/docs/server/)、[SDK](https://docs.opencode.ai/docs/sdk/)、[embedded SDK](https://opencode.ai/v2/docs/build/sdk)、[v2 API](https://dev.opencode.ai/v2/docs/api/)、[event handler source](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/event.ts)、[permission handler source](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/permission.ts)。
- Claude Agent SDK：[overview](https://code.claude.com/docs/en/agent-sdk/overview)、[hosting](https://code.claude.com/docs/en/agent-sdk/hosting)、[sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)、[user input](https://code.claude.com/docs/en/agent-sdk/user-input)、[streaming input/output](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[Python client source](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py)。
- ACP：[architecture](https://agentclientprotocol.com/get-started/architecture)、[v1 overview](https://agentclientprotocol.com/protocol/v1/overview)、[v1 transports](https://agentclientprotocol.com/protocol/v1/transports)、[v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)、[v2 overview](https://agentclientprotocol.com/protocol/v2/overview)、[v2 transports](https://agentclientprotocol.com/protocol/v2/transports)、[v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)、[v2 tool calls](https://agentclientprotocol.com/protocol/v2/tool-calls)、[v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)。
