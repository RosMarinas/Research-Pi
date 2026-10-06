# Pi Web Harness 一手资料调研

调研日期：2026-10-06。范围是 Pi 作者/官方仓库与包、Pi Web UI 作者仓库，以及本机 `/Users/polaris/Documents/Utils/deepseek-harness` 的 Web、会话和工具卡实现。下面把仓库 README/源码明确写出的行为称为“资料事实”；没有看到协议保证的地方标为“推论/建议”。没有读取密钥，也没有启动或修改运行中的服务。

## 先给结论

建议把 Pi 的“统一多项目 Web Harness”拆成三个所有权层：

1. **Host/daemon** 持有项目目录、Pi `AgentSession`/`AgentSessionRuntime`、凭据、持久会话和事件序列；每个活动会话只有一个运行时 owner。
2. **本地协议**（Unix socket）和 **Web gateway** 都是 presentation client。客户端只提交带 `requestId` 的命令，订阅带序号的状态/事件快照，不直接持有 API key 或 Node `AgentSession`。
3. **Web UI** 复用组件和呈现注册表：项目/会话侧栏、聊天消息、工具卡、命令面板、审批/问题表单都从 host snapshot 渲染。浏览器本地 store 只能保存布局、草稿等 UI 偏好，不能成为 transcript 或运行时真相。

最接近这个边界的现成方案是作者新出的 [`@earendil-works/pi-server`](https://github.com/earendil-works/pi/blob/main/packages/server/README.md) + [`@earendil-works/pi-protocol`](https://github.com/earendil-works/pi/blob/main/packages/protocol/README.md)：它已经定义了 `serverId/sessionId/attachmentId` 路由、多 presentation attachment、取消、订阅和 Unix transport 的方向，但明确是 **experimental**，应用仍要提供 `SessionDirectory`、`SessionManagement`、Session worker、业务 service schema 和 peer authentication。它可以作为协议/生命周期参考，当前不应当被当成完整 Web Harness。

若沿用父方案的每工作区 daemon + Unix socket + Web gateway，推荐吸收 `pi-server` 的 attachment 语义和 `xing-shuyin/pi-web-ui` 的产品级 UX，同时保留 Pi SDK 的 SessionManager/AgentSessionRuntime 作为唯一执行和历史来源。

## Pi 本体与作者当前分层

Pi coding-agent 的作者文档把 SDK、RPC 和 TUI 明确分开：

- [SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)说明 `createAgentSession()` 在 Node/Bun **进程内**创建 `AgentSession`；一个 Session 拥有一个 conversation、model、tools、队列、compaction 和 extension runtime。持久历史由 `SessionManager` 管理，`cwd` 参与资源发现、会话分组和内置工具路径。
- 同一文档说明 `AgentSessionRuntime.newSession()/switchSession()/fork()/importFromJsonl()` 会替换 active `AgentSession` 并重建目标 cwd 的服务；替换后旧 Session 的 subscriptions 必须重新绑定。这是实现 remote facade 时最容易丢事件的边界。
- [RPC 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)说明 RPC 是长生命周期子进程，通过 stdin/stdout JSONL 收命令、响应和 session events；SDK 是完整进程内 API，RPC 适合隔离进程和 custom client。成功的 `prompt` response 只代表 accepted/queued/handled，完成要看事件流的 `agent_settled`。
- [RPC Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)支持 `select/confirm/input/editor` 请求以及 `notify/setStatus/setWidget/setTitle/set_editor_text`，但 `custom()`、terminal input、footer/header、custom editor component、theme 等 TUI 专属能力在 RPC 中不可用或降级。Pi 的 [extensions 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ui-and-modes)也要求把工具/事件行为与渲染解耦。

因此，Pi core 并没有一个可直接挂出的“官方 Web UI 进程”。当前 Web UI 是外部作者包；原生 `InteractiveMode` 的组件和 `ctx.ui.custom()` 不能自动变成浏览器组件。多会话并行需要多个 Session worker，或显式的运行时池；不能把一个 `AgentSessionRuntime` 的 active-session replacement 误当成并行 owner。

## Pi Web UI 作者资料

| 资料 | 进程/运行时 owner | 传输和历史 | UI/许可证/适配判断 |
| --- | --- | --- | --- |
| [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui)；[`package.json`](https://github.com/xing-shuyin/pi-web-ui/blob/main/package.json)；[`npm`](https://www.npmjs.com/package/pi-web-ui) | README 写明 Pi SDK 在服务端运行，Pi engine in-process；DSH 为 subprocess。每个 conversation 有自己的 agent runtime；作者 README 写“每项目最多 8 个开放 conversation”。 | 浏览器经 WebSocket 收 server snapshot；历史读 `<agentDir>/sessions/--<cwd>--/`，与 CLI/TUI transcript 共用；切换项目不重启。 | MIT，作者 xing-shuyin，要求 Node ≥22.19。产品能力最完整：streaming/thinking/tool/bash、follow-up/steer、slash command、fork/re-ask、文件树、终端、模型设置、插件 tab/tool。适合抄协议边界和 UX；README 的“重连恢复/中断提示”是产品行为描述，不等于通用 replay 保证。 |
| [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui) | 组件示例直接在浏览器创建 `pi-agent-core Agent`。`AppStorage`/`SessionsStore`/`ProviderKeysStore` 可用 IndexedDB；它不是 Pi coding-agent daemon 或多项目 broker。 | browser-local Agent/events/storage；宿主若要远程化，必须把 Agent 接口换成 host snapshot adapter。 | MIT，mini-lit + Tailwind。可复用 `ChatPanel`、`AgentInterface`、`ModelSelector`、session/settings/key dialogs、attachment/artifact UI 和 `registerToolRenderer`。旧 [`@mariozechner/pi-web-ui`](https://www.npmjs.com/package/@mariozechner/pi-web-ui?activeTab=versions) 已标记 deprecated，npm 建议迁移到 earendil-works 包。 |
| [`@earendil-works/pi-server`](https://github.com/earendil-works/pi/blob/main/packages/server/README.md)（[npm 元数据](https://www.npmjs.com/package/@earendil-works/pi-server)）+ [`pi-client`](https://www.npmjs.com/package/@earendil-works/pi-client) + [`pi-protocol`](https://github.com/earendil-works/pi/blob/main/packages/protocol/README.md) | 应用提供 `RoutedServerServiceHost`、Session resolver/factory；server 只路由，Session/Harness 留在 worker 进程。一个 Session 可有多个 presentation attachment。 | 协议支持显式 `{serverId}` / `{serverId, sessionId, attachmentId}`、request/response、取消、opaque subscription updates、attachment out-of-band changes；作者示例有 Unix socket，client transport 可换 WebSocket/Unix/有序字节流。 | npm 元数据列为 MIT；`server`/`protocol` README 明确 experimental、无 compatibility guarantee，peer authentication 是应用策略，server 不解码业务 payload。适合借鉴 route fencing、attachment 和 snapshot/update 语义，暂不当成稳定公共 API。 |
| [`Watercol/pi-web-ui`](https://github.com/Watercol/pi-web-ui) | CLI bridge 连接一个正在运行的 Pi；`--cwd/--host/--port/--pi-bin`。 | 浏览器到本地 Pi bridge；默认 loopback。 | MIT。实现较小，适合单运行实例/快速桥接；没有资料证明其具备多项目 runtime registry。 |
| [`versot/pi-web`](https://github.com/versot/pi-web) | README 称 local-first，不是独立 agent/隔离 workspace；读写同一 `~/.pi/agent` config/session 数据。 | `npx @versot/pi-web web` 默认 `127.0.0.1:19707`；能显示和恢复 Pi session、MCP、skills/commands。 | MIT。可借鉴“Web/终端共享真实 Pi 状态”；不要据此推断有常驻多 runtime。 |
| [`Zetaphor/pi-webui`](https://github.com/Zetaphor/pi-webui) | README 描述 Node/Express/ws 服务端运行真实 Pi `AgentSession`，Lit SPA 为客户端。 | `/api/ws` JSON WebSocket protocol；客户端使用 `@mariozechner/pi-web-ui` 的 `MessageList`/`MessageEditor`/`StreamingMessageContainer`。 | 适合参考“服务端 SDK + typed WS + 组件层”的薄协议结构；组件包已迁移到 earendil-works。 |
| [`Scetrov/pi-web-agent`](https://github.com/Scetrov/pi-web-agent) | loopback web bridge + React SPA；README 明确 browser `sessionId` 是隔离的 in-memory session。 | 流式 text/thinking/tool lifecycle、history、slash commands、todo/subagent activity。 | README 明确不共享 terminal chat history；这与“统一 Pi 终端/Web transcript”目标冲突，但可用作隔离式客户端反例。 |

`xing-shuyin/pi-web-ui` 另有两个值得保留的边界：README 写明默认 loopback、WebSocket 检查 Origin/Host，同源之外需要显式 allowlist；provider key/header 留在 server，browser 只看到 nickname。其 npm/package manifest 还说明它默认加载自己嵌套的 `@earendil-works/pi-coding-agent`，全局升级 Pi 不会自动改变 Web server 实际使用的 SDK copy；这对父方案的版本漂移和升级提示很重要。

## 本机 DeepSeek Harness 的可复用结构

### Host、会话和事件

DeepSeek Harness 的架构文档把 `ctx` 服务按插件拆开：Session log 是模型看到的 context source；durable `session/*` events 与 live `agent/*` events 分开，UI 从 `session/event` 渲染，live hooks 只观察进行中的 agent。见本机 [`docs/architecture.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/architecture.md:21>) 和 [`docs/event-producer-consumer.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/event-producer-consumer.md:1>)。这提供一个可直接搬到 Pi 的划分：

- **持久层**记录最终消息、tool call/result、队列/命令/审批等会话事实；刷新后由 log 重建。
- **live 层**记录当前运行、流式增量、等待审批/问题、取消和 transport 状态；不能假设每个增量都已持久化。
- **presentation 层**只收 immutable snapshot 或 event projection，不让 React 组件持有 Agent 对象。

DeepSeek 的客户端 Session contract 也很适合变成 Pi host API：[`ISession`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/runtime/src/client/contract/session.ts:29>) 只暴露 `prompt(content, mode)`, `updateQueue`, `cancel`, `rename`, `loadOlder`, `command` 等行为，以及 read-only snapshot；[`IWorkspaces`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/runtime/src/client/contract/workspaces.ts:13>) 把 workspace create/rename/delete/reorder、session connect/start/archive 与 directory picker 分开。对 Pi 来说，`projectId/workspaceId` 应与 `sessionId` 独立，侧栏的项目树不要把 cwd 字符串当作 Session ID。

### Web carrier 与 reconnect 边界

本机 [`dsh-host-webserver`](</Users/polaris/Documents/Utils/deepseek-harness/packages/host/webserver/src/index.ts:1>) 是无 harness 知识的 `node:http` carrier：named route、prefix route、fallback、upgrade 都由功能插件注册；只允许 `127.0.0.1` 或 `0.0.0.0`，源码明确没有 TLS、auth 或 origin policy。若 Pi Web gateway 绑定 LAN，必须在更上层提供 token/session auth、Origin/Host policy 和 TLS/reverse proxy；不能把 loopback 默认误当成远程安全边界。

本机 [`WebSocketDownlinks`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/connection/src/websocket-downlink.ts:46>) 将 mux 和 host events 分为两个 downlink，客户端向 WS 发消息会被视为 protocol violation；请求走 HTTP RPC。断线会 abort 当前 pump，carrier 本身不承诺事件 replay。SessionRuntime 注释则明确 list 在 reconnect 时重新 pull，并以当前选择恢复 stage（[`service.ts`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/runtime/src/client/sessions/service.ts:1)）。这是一条重要 caveat：**“重连后重新拉 baseline”可由源码确认；“从断点重播所有 event”在这些资料中没有保证。** Pi Web 实现应显式发送 `serverGeneration + sessionRevision/eventSeq + full snapshot`，发现 gap 就重新 hydrate，而不是猜测浏览器漏掉了哪些 delta。

DeepSeek 的 client module registry 通过 `window.__DSH_BOOT__`、每 bundle 的 `rev`、graph `rev` 和 index injection 保证浏览器加载一致的插件图（[`client-modules.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/subsystems/client-modules.md:1>)）。Pi 若支持可热插拔 UI/plugin，可借鉴“manifest + content rev + lazy client bundle”；不要让任意扩展直接向 WebSocket 写未版本化的业务 frame。

### 侧栏和多项目浏览

侧栏的 owner 只管布局和 slot，workspace plugin 负责浏览区。见 [`ui-sidebar` apply](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-sidebar/src/client/index.ts:25>)、[`SidebarRoot`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx:1>) 和 [`WorkspaceBrowser`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx:1>)：

- 宽侧栏显示 New Session、搜索、按 workspace 分组或 flat list、排序（manual/updated）、最近会话、workspace/session rename/fork/archive/delete、拖动重排；窄屏只显示控制 rail。
- 列表把 workspace group、ungrouped sessions、current selection 和 `running/pending/completed` 状态分开；搜索通过 host `sessions.search`，而不是在 UI 中扫描完整 transcript。
- `WorkspaceBrowser` 将展示顺序的本地偏好与 host 的真实 reorder action 分开：manual sort 仅改视图；持久 reorder 才调用 `insertBefore`/`insertSessionBefore`。

可复用建议：Pi 的左栏采用 `ProjectDirectory -> Session rows` 两级模型，并给每行挂 `running`, `waiting approval/question`, `error`, `completed` 投影；把 workspace picker、recent projects、session history、runtime status 放在同一页面，但保留各自命令和 owner。

### 聊天、工具卡、命令和状态

DeepSeek UI 把聊天流和 tool card 分成两层：[`ToolCallTree`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:1>) 以 `callId` 建树，按 `toolName` 通过 keyed slot dispatch，未知工具落到 `GenericToolCard`；[`ToolRow`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx:1>) 统一 collapsed summary、running/error/stopped 状态、输入/输出、可展开 bounded card；[`ToolDetails`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-tool/src/client/tool/ToolDetails.tsx:19>) 在 details panel 用 terminal/diff/read/search/web 等结构化组件渲染，未知类型保留文本。

这比为每个工具写一套页面更稳：Pi host event 只需提供 `callId`, `toolName`, `phase`, `argsSummary`, `resultSummary`, `error`, `renderIntent` 和可选 `details`；Web renderer 用 `toolName/renderIntent` 注册卡，再保留 generic fallback。长输出在卡片内滚动，details panel 才提供完整阅读面，避免工具输出淹没聊天流。

队列可直接借鉴 [`QueueDock`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-conversation/src/client/queue/QueueDock.tsx:1>)：读取 session-scoped queue snapshot，允许 edit/remove/steer，所有 mutation 通过当前 Session face，运行期间按 owner policy 禁用不安全操作。Pi SDK 文档也区分 steer 与 follow-up，且明确 prompt response 不代表 run 完成；因此命令 API 必须返回 admission/disposition，并用 event/snapshot 反映 settled。

### 审批、问题和扩展 UI

DeepSeek 的 [`ApprovalPanel`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ApprovalPanel.tsx:1>) 是 composer takeover：pending approval 存在时替换 InputBar，显示理由和关联 tool call，按钮一次点击后锁定，收到 resolved frame 才退出；[`QuestionComposer`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-user-questions/src/client/QuestionComposer.tsx:47>) 保留稳定 request key、批量 question id、选项/custom answer、取消和失败重试。服务端规范见 [`approval.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/subsystems/approval.md:21>) 和 [`user-questions.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/subsystems/user-questions.md:23>)：approval 是 closed outcome、`allowed-once` 才放行；question 是一个 request 多个 stable id；exact live runtime owner 决定谁可以回答。

Pi RPC 的 Extension UI 只覆盖 select/confirm/input/editor，不覆盖原生 TUI `custom()`；所以 Web Harness 应把审批/问题建模成 host-owned pending interaction：

- server 为每个 pending request 生成 `interactionId`，绑定 `sessionId`, `callId`, `runtimeGeneration`；
- browser 只提交一次 answer/cancel，server 做 owner、过期和重复答复检查；
- reconnect baseline 包含未决 interaction，旧 generation 的回答必须拒绝；
- UI 未知 intent 退回通用选择/文本表单，不能因新扩展卡片缺失而卡死 agent；
- approval 默认 fail-closed；没有可用 UI 或 transport 断开时不能隐式放行。

## 对 Pi 统一 Web Harness 的可复用建议

### 1. 运行时目录和 attach 模型

建议最小状态模型是：

```text
HostDaemon
  ProjectDirectory: projectId -> cwd/title/settings
  SessionDirectory: sessionId -> projectId/history metadata/runtime status
  RuntimeRegistry: (projectId, sessionId) -> one AgentSession owner
  PresentationRegistry: connectionId -> attachmentId -> sessionId
  EventJournal/Revision: per session durable seq + live generation
```

`AgentSessionRuntime` 若用于 session replacement，必须在 replacement 后集中 rebind events/UI/commands；并行 Web tabs 不应共享一个“当前 active Session”对象。更简单的并行实现是一个 session 一个 runtime/worker，项目 daemon 只做 registry 和 lifecycle。零 presentation 且 runtime idle 时才回收，运行中的 worker 不因浏览器切换而停止。

### 2. 传输协议

可参考 `pi-protocol` 的 route fence：`serverId` 防止连接到错误 daemon，`sessionId` 指定 durable history，`attachmentId` 防止 stale client 在 session 切换后继续写入。Pi 1.0 现有 RPC 的 JSONL command/event framing 可用于 worker 边界；对浏览器再包一层 HTTP unary command + WebSocket event stream，避免把 stdin/stdout 暴露给 Web。

协议至少需要：`hello(serverGeneration, protocolVersion)`, `project/session catalog`, `attach/detach`, `snapshot(revision)`, `event(seq)`, `resync`, `request/response(requestId, disposition)`, `cancel`, `interaction/answer`, `server shutdown`。资料没有证明任何现有 Pi Web UI 会在网络断线后无损 replay；应把“full snapshot + revision gap resync”作为自己的明确保证。

### 3. UI 组件复用边界

优先复用 `@earendil-works/pi-web-ui` 的 presentation primitives（消息、附件、artifact、工具 renderer、model/settings dialogs），或吸收其 CSS/交互；不要直接采用其 browser-local `Agent`/IndexedDB `SessionsStore` 作为 Pi daemon 的 session truth。对复杂 coding-agent tool cards，DeepSeek 的 keyed `tool.call.toolview` + generic fallback 更适合扩展：新工具只注册 renderer，旧客户端仍能显示通用输入/输出。

### 4. 凭据、项目信任和权限

凭据及 provider headers 应留在 daemon；浏览器只看 provider/model 名称、能力和健康状态。默认 bind `127.0.0.1`；需要 LAN/Tailscale 时，在 gateway/reverse proxy 处加认证、Origin/Host allowlist 和 TLS。Pi 的 RPC/TUI trust prompt 语义不自动变成 Web authorization：项目 trust、tool approval、extension user question 都要作为 host-owned request 显式路由。Pi 安全文档还明确：print/JSON/RPC 不能显示 built-in project trust prompt，需 `--approve`、`--no-approve`、保存决策或默认策略；Web facade 要在启动/attach 时给出等价 policy surface，而不是静默跳过。

### 5. 许可证和升级

目前核实到的 Pi core、`pi-web-ui`、`@earendil-works/pi-web-ui`、`pi-server`、`pi-client`、`pi-protocol` npm metadata/仓库均标 MIT；具体第三方 UI plugin、Pi extension 和 DSH plugin 仍需逐项复核，不能从宿主包许可证推断依赖许可证。`xing-shuyin/pi-web-ui` 默认嵌套 SDK copy 的事实意味着应在 Web Harness UI 里显示“实际 engine package/version”，并提供升级/兼容性诊断；否则 CLI 与 Web 运行时可能悄悄使用不同 Pi 版本。

## 尚未被资料保证的事项

- **重连 replay**：`xing` README 描述重连恢复 workspace、server 中断提示；DeepSeek SessionRuntime 描述 reconnect re-pull；`pi-server` 描述 attachment/response cleanup。没有看到“按 event seq 从任意断点 replay 且不重复/不丢失”的 Pi Web 公开保证。应由 Pi host 自己定义并测试。
- **多 UI 并发答案**：`pi-server` 允许一个 Session 多 presentation attachments，但 application 仍要定义 answer arbitration、谁能 steer、哪个 UI 获得 modal ownership。不要默认两个浏览器可以同时 approve 或编辑同一 queue。
- **多项目容量**：只有 `xing` README 明确写每项目最多 8 个 open conversations；这是作者实现上限，不是 Pi SDK/协议保证。Pi daemon 的 worker 数、CPU、模型并发和回收策略需单独定义。
- **Web 安全**：DeepSeek carrier 的 `0.0.0.0` 模式无 auth/TLS/origin policy；`pi-protocol` experimental transport 也把 peer authentication 留给应用。任何远程暴露都必须在 Pi gateway 外加安全层。
- **原生 TUI parity**：Pi RPC 明确不支持 custom terminal components；复用 engine 不会自动保留 TUI 每个扩展交互。应将可迁移能力限定为 prompt/model/session/queue/events/标准 dialogs，并给 Web 扩展提供独立 renderer contract。

## 主要来源

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) · [RPC Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md) · [Extensions and modes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ui-and-modes)
- [Pi server README](https://github.com/earendil-works/pi/blob/main/packages/server/README.md) · [Pi protocol README](https://github.com/earendil-works/pi/blob/main/packages/protocol/README.md) · [Pi client npm](https://www.npmjs.com/package/@earendil-works/pi-client)
- [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) · [package manifest](https://github.com/xing-shuyin/pi-web-ui/blob/main/package.json) · [npm package](https://www.npmjs.com/package/pi-web-ui)
- [@earendil-works/pi-web-ui](https://www.npmjs.com/package/@earendil-works/pi-web-ui) · [deprecated @mariozechner package](https://www.npmjs.com/package/@mariozechner/pi-web-ui?activeTab=versions)
- [Watercol/pi-web-ui](https://github.com/Watercol/pi-web-ui) · [versot/pi-web](https://github.com/versot/pi-web) · [Zetaphor/pi-webui](https://github.com/Zetaphor/pi-webui) · [Scetrov/pi-web-agent](https://github.com/Scetrov/pi-web-agent)
- 本机 DeepSeek Harness：[`architecture.md`](</Users/polaris/Documents/Utils/deepseek-harness/docs/architecture.md:21>)、[`web-server/index.ts`](</Users/polaris/Documents/Utils/deepseek-harness/packages/host/webserver/src/index.ts:1>)、[`WebSocketDownlinks`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/connection/src/websocket-downlink.ts:46>)、[`SessionRuntime`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/runtime/src/client/sessions/service.ts:228>)、[`IWorkspaces`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/runtime/src/client/contract/workspaces.ts:13>)、[`ToolCallTree`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:1>)、[`QueueDock`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-conversation/src/client/queue/QueueDock.tsx:1>)、[`ApprovalPanel`](</Users/polaris/Documents/Utils/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ApprovalPanel.tsx:1>)。
