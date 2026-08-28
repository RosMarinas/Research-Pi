# Research Pi Prompt Inventory

> 审阅基线：ProjectView prompt protocol v4；Windows 分支在 main 提交后同步。
>
> 本文是 prompt 的**完整入口清单与组合说明**，不是第二份可执行配置。较长 prompt 保留单一权威源码并直接链接，避免复制后两份文字漂移；较短或动态 prompt 在本文中给出原文/模板。

## 1. 什么算 prompt

本文纳入所有由 Research Pi 自己维护、会进入模型输入并影响行为的内容：

1. Leader 的稳定 system prompt 增量与身份替换；
2. skill 指令；
3. 工具的 `description`、`promptSnippet`、`promptGuidelines` 和参数 schema；
4. ProjectView、Analysis 角色、Runtime mailbox 等动态上下文消息；
5. `/side`、research compaction、DeepSeek Web Search 等独立模型调用的 prompt；
6. Codex advisor/executor 的委派 prompt、动态工具和结果 schema；
7. 可选 DeepSeek V4 Pro anchor 实验对 provider payload 的 prompt 重写；
8. Windows/WSL 分支额外加入的模型指令。

不纳入：纯 TUI 菜单/状态栏/通知、日志、测试 fixture、普通工具执行结果，以及用户自己输入的任务正文。它们可能出现在 transcript 中，但不是 Research Pi 设计的稳定 prompt。

## 2. Prompt 是怎样组合起来的

正常 Leader 请求大致由以下层组成：

```text
Pi Core 原生 system prompt（上游依赖）
  -> Research Pi 替换首句身份
  -> Pi Core 加载项目 instructions / skill catalog
  -> 追加 Research operating contract
  -> 暴露当前工具 descriptions + schemas + guidelines
  -> 注入 ProjectView snapshot 或 delta（需要时）
  -> 注入尚未消费的 Runtime mailbox 消息（有真实消息时）
  -> 当前会话历史与用户请求
```

启动器明确关闭 Pi Core 的自动 skill/extension 发现，然后只加载受控清单，见 [`bin/pi.mjs`](../bin/pi.mjs#L217-L258)。因此下面列出的 extension/skill 就是当前正常启动面的全集；只有 `web_search` 受配置开关控制。

建议按以下优先级审阅：

| 优先级 | Prompt 面 | 为什么先看 |
|---|---|---|
| P0 | `APPEND_SYSTEM.md`、ProjectView、Runtime/Analysis、Codex delegation | 决定角色、通信、自动续作和权限边界，且语义有重叠 |
| P1 | 工具 prompt | 决定模型何时调用状态、记忆、证据、权限和委派工具 |
| P1 | compaction prompt | 决定长期 Project State 如何被压缩、继承和失真 |
| P2 | research briefing skill、`/side`、Web Search | 局部触发，不持续控制每一轮 |
| P2 | V4 Pro anchor | 默认关闭的实验路径，但会彻底改写 provider payload |

## 3. Leader 的稳定 system prompt

### 3.1 Pi Core 基础 prompt 与身份替换

Research Pi **不拥有 Pi Core 完整的原生 system prompt**；那部分来自固定依赖 `@earendil-works/pi-coding-agent`。Research Pi 只精确替换它的第一句，源码见 [`research-mode.ts`](../.pi/extensions/research-mode.ts#L3-L18)。

被替换的原句：

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
```

替换为：

```text
You are a computational research agent operating inside Pi, an agent harness for scientific work. You investigate research questions through code, experiments, diagnostic probes, evidence analysis, and reversible implementation changes. Code is primarily an experimental instrument until a method earns convergence.
```

简单解释：把默认“编码助手”的主身份改为“计算研究代理”，但保留 Pi Core 后续关于工具、项目文件、上下文和通用行为的原生指令。如果上游首句变化，当前实现会 fail-safe 地不替换，而不是模糊匹配。

### 3.2 Research operating contract

权威全文：[`APPEND_SYSTEM.md`](../.pi/APPEND_SYSTEM.md)。启动器用 `--append-system-prompt` 在每个正常模型请求中加入它。

它经过职责收敛后包含六组长期不变量，当前大小受 12,000 字符预算测试约束：

| 段落 | 简单解释 |
|---|---|
| Research objective and method | 默认优化研究信息增益，要求竞争假设、高区分实验并阻止低信息 patch loop |
| Evidence and Project memory | 规定 experiment/transition/amendment/memory/clean/side 的证据与状态边界 |
| Runtime roles and event semantics | 区分 Leader/Analysis、ProjectView、mailbox 与普通 tool continuation |
| Communication with the user | 保留结果优先与 decision lineage；详细 briefing 方法按需进入 skill |
| Web research and Codex collaboration | 规定 Web/Codex 分工、mission、mailbox 与结果解释 |
| Authority and safety | 定义 project sandbox、host broker、SSH/凭据和破坏性动作边界 |

精简原则：system 只拥有跨工具不变量；工具拥有局部调用协议；ProjectView 只携带数据；mailbox 只携带一次性事件。该文件已从 18,782 字符降至约 11.3k。

### 3.3 项目 instructions 与 skill catalog

Pi Core 会把工作区中的项目指令文件和可用 skill catalog 加进原生 prompt。这部分内容依项目变化，不由 Research Pi 写死。Research Pi 自带且总是显式加载的 skill 只有：

- [`research-briefing/SKILL.md`](../.pi/skills/research-briefing/SKILL.md)：当用户需要恢复研究主线、解释长委派结果、冲突证据或阶段变化时，要求输出最短但足够作判断的研究叙事。普通窄问题不触发。

其完整 prompt 就是该 `SKILL.md` 的 frontmatter 与正文。额外 skill 来自用户配置 `resources.skills`，不是仓库内固定 prompt。

## 4. Leader 可见的工具 prompt

每个工具同时向模型暴露 `description`、参数 JSON Schema；部分工具还通过 Pi Core 的 system prompt 汇总 `promptSnippet` 与 `promptGuidelines`。下表覆盖当前启动器加载的所有 model-callable Research Pi 工具。

### 4.1 权限与 shell

#### `bash`

源码：[`project-boundary.ts`](../.pi/extensions/project-boundary.ts#L427-L439)

```text
snippet: Execute shell commands inside the current project boundary with role-scoped write and network authority

guidelines:
- Leader shell may read/write the current project, including Git metadata. Analysis shell uses an OS-enforced read-only project profile with only project-local runtime temp writable. Neither role can access other user directories or write system temp paths.
- Leader project shell has public network access. Analysis local shell has no network; use web_search for public evidence and host_capability for approved SSH inspection. Command syntax is not a policy boundary.
- Unix sockets and host credential files remain outside the project sandbox. If a justified operation needs them, use host_capability command or a project-trusted SSH target instead of asking the user to copy a terminal command.
```

简单解释：保留 Pi Core `bash` 的基础 schema/description，只替换边界相关提示；Analysis 会在执行层拒绝 `bash`。

#### `host_capability`

源码：[`project-boundary.ts`](../.pi/extensions/project-boundary.ts#L353-L382)

```text
description: Use a host capability when a justified project operation needs SSH credentials or host-user authority. read accesses an approved external file; ssh uses an approved exact target with opaque credentials; command runs an argv inside the project cwd with host authority; script is the legacy strict exact-script mode. In an Analysis Session, exact external reads and conservative SSH inspection are available; broader exact SSH commands can be requested from the user without promoting the Session. Project-trusted SSH targets and command prefixes run without repeated approval. Never use this tool to inspect private keys, tokens, or credential stores.

snippet: Use project-trusted SSH or host-command capabilities instead of handing executable commands back to the user

guidelines:
- Leader project bash is writable. Analysis project bash is OS-enforced read-only; a broader exact Analysis SSH command requires user approval through this tool.
- For justified host authority, send the exact target or argv. Reuse a listed grantId so its approved cwd is restored; on cwd mismatch retry the same capability rather than switching kind or adding a shell wrapper.
- SSH credentials remain opaque. Host commands must match approved authority; never request, read, print, copy, or transmit private keys, tokens, or credential stores.
- A missing capability is a user authorization boundary. Do not route around it with bash, symlinks, proxy commands, copied credentials, or another agent.
```

Schema 字段：`action=list|read|ssh|command|script`、`path`、`target`、`port`、`remoteCommand`、`grantId`、`argv`、`cwd`、`args`、`timeoutSeconds`。字段的精确描述见同一源码段。

### 4.2 研究证据与 Project State

#### `record_experiment`

源码：[`record-experiment.ts`](../.pi/extensions/record-experiment.ts#L116-L156)

用途：只记录会改变研究判断的结果，并严格分离预测来源、evidence mode、观察、有效性和结论。

关键 prompt：

```text
description: Persist one lightweight research memo when an observation changes a research judgment. Do not use for ordinary probes, routine commands, or plans without results.
snippet: Record a decision-changing experiment result in the project research ledger
```

三条 guidelines 分别约束：证据模式的诚实选择；禁止事后补造并保留预注册/有效性边界；旧 route 与运行代码身份必须精确。Schema 的全部字段及描述在上述源码段中。

#### `record_research_transition`

源码：[`research-transition.ts`](../.pi/extensions/research-transition.ts#L14-L40)

```text
description: Record a rare project-level change of active research direction so later Sessions do not treat the previous route as current. This is not for ordinary next steps, implementation changes, or minor hypothesis updates.
snippet: Record a decision-changing research route transition in Project Runtime
```

四条 guidelines 要求：只有明确重定向或被证据支持的 route 变化才记录；不能把文件变化/Codex 完成误判为 transition；旧证据仍保留；parallel route 必须复制精确 `fromTrackRef`。字段：`from`、`fromTrackRef`、`to`、`reason`、`oldDisposition`、`nextDecision`、`authorityRefs`。

#### `amend_project_state`

源码：[`amend-project-state.ts`](../.pi/extensions/amend-project-state.ts#L70-L101)

```text
description: Apply a narrow, explicit correction to the current structured Project State without waiting for compaction. The amendment is append-only, source-labelled, and rejected if Project revision or Leader ownership changed.
snippet: Correct a bounded part of current Project State with authority and revision provenance
```

四条 guidelines 区分 narrow correction、初始 compaction 和 route transition；要求精确 revision、最小 patch、完整 freshness 处理和真实 evidence reference。字段：`basedOnRevision`、`reason`、`authorityRefs` 和结构化 `patch`。

#### `research_checkpoint`

源码：[`research-checkpoint.ts`](../.pi/extensions/research-checkpoint.ts#L30-L43)

```text
description: Create a persistent Git ref for the current tracked code state without changing the branch, index, or working tree. Use only at a research decision boundary. Untracked files are reported but not captured.
snippet: Create a persistent, non-mutating Git checkpoint at a research decision boundary
guidelines:
- Use research_checkpoint only before a high-contrast intervention, rollback, or abandonment of a research route; never call it automatically every turn or for read-only work.
- research_checkpoint does not capture untracked files. If they matter, explicitly review and stage only the intended files before checkpointing; never stage secrets or large artifacts.
```

字段：`label`、`rationale`。

### 4.3 历史记忆

#### `research_memory_search`

源码：[`research-memory.ts`](../.pi/extensions/research-memory.ts#L65-L107)

```text
description: Search prior Pi sessions and recorded experiments using a local, non-vector full-text index. Returns bounded snippets with stable session/entry provenance; it does not automatically inject history.
snippet: Search prior project sessions and experiment evidence when earlier work is materially relevant
guidelines:
- Use research_memory_search when the user refers to earlier sessions, previous experiments, an old decision, or when resolving uncertainty would benefit from known prior evidence. Do not call it routinely every turn.
- Prefer recorded-evidence hits over assistant-synthesis or derived-summary hits. Read the exact entry before treating a snippet as evidence, and preserve its P:<project>/S:<session>/E:<entry> reference.
- Absence of a search hit is not evidence that an experiment was never run; report the searched scope and query when absence matters.
```

字段：`query`、`scope=current_project|all_projects`、`kinds`、`after`、`before`、`limit`、`includeCurrentSession`、`includeAbandonedBranches`。

#### `research_memory_read`

源码：[`research-memory.ts`](../.pi/extensions/research-memory.ts#L133-L152)

```text
description: Read an exact indexed historical entry and a small surrounding window after research_memory_search. Content is local, bounded, redacted for common credential patterns, and accompanied by hashes and provenance.
snippet: Verify a historical memory hit against its exact entry and nearby context
guidelines:
- Call research_memory_read only for a concrete hit returned by research_memory_search, unless the user supplied an exact session and entry ID.
- Treat assistant and compaction text as fallible prior reasoning. Recorded experiments still require their stated validity judgment to support a conclusion.
```

字段：`projectKey`、`sessionId`、`entryId`、`radius`、`maxChars`。

### 4.4 Analysis 到 Leader 的通信

#### `analysis_send_to_leader`

只在 Analysis 角色下有意义，源码：[`research-runtime.ts`](../.pi/extensions/research-runtime.ts#L1426-L1438)

```text
description: Send a concise discussion synthesis or recommendation from this read-only Analysis Session to the durable mailbox of the current Leader Session. This does not update Project State or count as evidence.
snippet: Send a concise candidate analysis to the working Leader without changing Project State
guidelines:
- Use only when the user wants the working Leader to receive a useful synthesis, competing explanation, question, or recommendation.
- Separate observations already present in ProjectView from your new interpretation. The message is a proposal, not experimental evidence.
```

字段只有 `message`。送入 mailbox 前会加：

```text
[Analysis Session handoff {{session_suffix}}]
{{message}}
```

### 4.5 Web Search（条件加载）

`web_search` 只有在 `researchPiDeepSeekSearchEnabled(...)` 为真时加载。Leader-facing prompt 见 [`deepseek-web-search.ts`](../.pi/extensions/deepseek-web-search.ts#L21-L37)：

```text
description: Run one bounded web lookup or small research pass through DeepSeek's native Anthropic-compatible Web Search. Use for current facts, direct sources, and limited cross-checking; use Codex when search and synthesis become substantial.
snippet: Search the current web directly for a bounded factual lookup
guidelines:
- Use web_search for a simple current lookup or to locate a few direct sources. State what claim the search is meant to verify.
- Pi may complete a bounded small research pass directly. Delegate to Codex when the user asks, or when the task genuinely needs many searches, substantial cross-checking, or enough intermediate organization to pollute the main context.
- Cite the returned URLs near claims. If the tool reports no structured sources, do not present its synthesis as web-verified evidence.
```

字段：`query`、`maxUses`。

### 4.6 `codex_delegate`（Leader-facing）

权威全文：[`codex-delegate.ts`](../.pi/extensions/codex-delegate.ts#L1097-L1132)。

工具 description 只概括 advisor/executor、Actor、host broker 和 Runtime mailbox。七条 guidelines 负责：何时隔离委派；如何选择 executor/advisor；mission 复用；host bridge；语义结果与 `outcome_unknown`；精确 respond；非终态后结束当前 run 并禁止轮询。配置的实际默认模型不再插入 prompt，避免配置变化改变工具 schema 前缀。

参数 schema 是另一个重要 prompt 面，见 [`codex-delegate.ts`](../.pi/extensions/codex-delegate.ts#L53-L157)。字段为 `action`、`mode`、`task`、`successCriteria`、`context`、`mission`、`reuse`、`model`、`reasoningEffort`、`background`、`timeoutMinutes`、`jobId`、`followUp`、`requestId`、`response`、`answers`、`message`、`outcome`、`note`。

## 5. ProjectView 与 Runtime 通信 prompt

这部分不是 system prompt，而是由 extension 作为隐藏 custom message 放进 Leader/Analysis 上下文。它最容易与“又收到一次外部消息”混淆，因此应单独审阅。

### 5.1 ProjectView snapshot

权威生成器：[`project-view.mjs`](../.pi/lib/project-view.mjs#L347-L502)。最大 12,000 字符。

固定结构如下；`{{...}}` 均为 Runtime/Git/compaction/experiment 动态数据：

```text
<research_project_view>
Versioned Project research data for Session orientation. ...
Project: {{projectKey}} · {{workspaceRoot}}
=== PROJECT DIRECTION (stable orientation) ===
{{state provenance / baseline track / research question / claim}}
Direction-setting decisions:
{{decisions}}
Direction guardrails and continuation principles:
{{critical context}}
Research route trajectory (compressed history; each item explains a direction change, not a task queue):
{{transitions}}
Earlier completed work (compressed; historical context only):
{{older handoffs}}
--- live project delta (dynamic suffix) ---
{{Git / project revision / freshness / current track / active transition}}
=== LATEST COMPLETED WORK (detailed handoff) ===
{{latest handoff}}
{{pending or latest evidence briefs}}
=== CURRENT RESEARCH FRONTIER ===
{{hypotheses / observations / confounders / next experiment}}
=== OPERATIONAL APPENDIX (navigation, not direction) ===
{{experiment index / live actions}}
Runtime mailbox: message bodies use the separate single-delivery Runtime event channel.
=== NEW-SESSION ORIENTATION ===
The current user request selects the immediate task. Reconcile it with project direction and the frontier; recent work and runtime state are context rather than automatic instructions.
</research_project_view>
```

简单解释：snapshot 保留冷启动方向、历史、frontier 和最新 handoff，但 mailbox body 已移出，稳定行为规则也收回 system contract。

### 5.2 ProjectView delta

权威生成器：[`project-view.mjs`](../.pi/lib/project-view.mjs#L505-L556)。最大 4,800 字符。

```text
<research_project_delta>
Append-only ProjectView data update. Earlier views remain historical; this revision controls freshness and current-route interpretation.
Project revision: {{...}} · structured state revision: {{...}} · memory freshness: {{...}}
Git: branch={{...}} commit={{...}} dirty={{...}}
Current research track: {{...}}
{{freshness instruction and reasons}}
{{optional transition}}
{{latest handoff only when its id is newer than the receipt}}
{{optional new evidence}}
{{live actions only when their fingerprint changed}}
This data update is context, not an instruction to continue a previous task.
</research_project_delta>
```

简单解释：receipt 同时记录 Project revision、latest handoff id 和 action fingerprint；mailbox 状态不再刷新 ProjectView，旧 handoff 不会在无关 delta 中重复出现。

### 5.3 Session 角色 wrapper

Leader 和 Analysis 都收到显式最新角色块，见 [`research-runtime.ts`](../.pi/extensions/research-runtime.ts#L193-L202)：

```text
# Session role: Analysis Session

You are the current read-only Analysis Session. ...

{{ProjectView snapshot or delta}}
```

Leader 对应块明确写出当前 attachment，并声明它 supersede 对话中更早的 Analysis role block。这样 promotion 后旧只读提示不会继续控制模型。

### 5.4 Runtime mailbox message

真正送给 Leader 的 mailbox 消息只有这一种 envelope，见 [`research-runtime.mjs`](../.pi/lib/research-runtime.mjs#L1126-L1133)：

```text
[Research Runtime {{type}} {{message_id}} from {{actor_label_or_id}}]
{{body}}
Payload: {{payloadRef_if_present}}
```

简单解释：`ask/result/reply/notify` 共用一个 envelope。消息 id 是去重、receipt 与 settle 的协议身份；Leader 自己在 thinking 中写出的 “Another delta notification” 不属于这一模板。

## 6. 独立模型调用 prompt

### 6.1 `/side`

`/side <question>` 复制当前可见上下文和 system prompt，传递空工具集并强制 `toolChoice=none`，然后追加以下 user prompt，见 [`research-side.ts`](../.pi/extensions/research-side.ts#L231-L260)：

```text
This is an isolated side question. Answer using the visible research context, but do not continue or alter the main task.
No tools are available in this call. Be self-contained and distinguish facts from inference.
The answer will be persisted outside the main model context unless the user explicitly promotes it.

{{side question}}
```

`/side use <id>` 才把结果加入主上下文，模板见 [`research-side.mjs`](../.pi/lib/research-side.mjs#L57-L66)：

```text
The user explicitly promoted a previously isolated side conversation into the main research context.
Side ID: {{id}}
Question:
{{question}}

Side answer (fallible assistant synthesis; verify consequential claims):
{{answer}}
```

### 6.2 Research compaction

权威 prompt：稳定 contract 与动态 evidence builder 均在 [`research-compact.mjs`](../.pi/lib/research-compact.mjs)；调用方式见 [`research-compaction.ts`](../.pi/extensions/research-compaction.ts#L175-L215)。

它现在拆成可短期缓存的稳定 system contract 与动态 user evidence，并只暴露 `submit_research_state`：

- 目标：维护 AI/通信计算研究工作状态，而不是软件进度总结；
- 输出约束：恰好调用一次 `submit_research_state`，否则输出单个 JSON；
- 12 条压缩后的 evidence/route/provenance/negative-result/critical-context 规则；
- required schema 只由工具提供，不再在 user prompt 中复制；
- 上次 structured state、legacy summary、独立 Session summary；
- experiments、transitions、checkpoints、允许的 conversational provenance；
- 用户 compaction focus 与待压缩对话。

`submit_research_state` 自身的 model-visible schema 在 [`research-compact.mjs`](../.pi/lib/research-compact.mjs#L14-L95)，要求：`researchQuestion`、`currentClaim`、`hypotheses`、`observations`、`decisions`、`unresolvedConfounders`、`openQuestions`、`nextExperiment`、`criticalContext`。

若第一次输出因长度截断，原 prompt 后追加：

```text
RECOVERY: The previous structured response was truncated. Return a minimal state well below the target budget. Keep only decision-relevant hypotheses, observations, provenance, and the next discriminating experiment; do not elaborate.
```

### 6.3 DeepSeek Web Search 子调用

`web_search` 工具内部再调用一个 DeepSeek 模型。子调用 system prompt 为：

```text
Answer one bounded lookup using the native web_search tool. Prefer primary and authoritative sources. Distinguish sourced facts from inference. Keep the synthesis concise; the caller will receive the structured source URLs separately.
```

user prompt 就是 Leader 传入的 `query`，并只暴露 provider-native `web_search` 工具。源码：[`deepseek-web-search.ts`](../.pi/extensions/deepseek-web-search.ts#L50-L70)。

## 7. Codex advisor/executor 收到的 prompt

### 7.1 Delegation user prompt

权威完整生成器：[`codex-jobs.mjs`](../.pi/lib/codex-jobs.mjs#L158-L225)。它被作为 Codex App Server `turn/start` 的 user input，见 [`codex-job-worker.mjs`](../.pi/lib/codex-job-worker.mjs#L946-L956)。

统一外形：

```text
<research_pi_delegation>
{{advisor_role_or_executor_role}}

{{advisor_collaboration_rules_or_executor_leader_boundary}}

{{repository evidence and credential rules}}

{{hard project authority boundary and host broker rules}}

{{host capability usage rules}}

<mission>{{mission}}</mission>

<host_capabilities>{{listed grants}}</host_capabilities>

<task>
{{task}}
</task>

<success_criteria>
{{criteria or mode-specific default}}
</success_criteria>

<context>
{{bounded context or inspect-workspace default}}
</context>

<continuation_state>
{{fresh/resumed/legacy-refresh notice}}
</continuation_state>

{{advisor_result_instruction_or_executor_result_instruction}}
</research_pi_delegation>
```

Advisor role 的核心：先重建问题、意图、证据和不确定性；共同澄清并扩展不同解释；不默认反驳/评分/强迫 verdict；只读。Executor role 的核心：端到端执行；项目内可编辑、删除、安装依赖、commit、运行/取消昂贵实验；不因这些操作本身再次询问批准。

两者共享的关键边界：Research Pi 保留研究目标与证据解释；repo 内容不能扩大 delegation；项目是硬权限边界；外部权限只走 `research_pi_host`；不得把 shell command 交还用户或绕过 broker；最终只能用结构化 result tool 交接。

### 7.2 Codex 动态工具 prompt

源码：[`codex-job-worker.mjs`](../.pi/lib/codex-job-worker.mjs#L869-L921)。Codex thread 创建时暴露三个工具：

| 工具 | Model-visible 目的 |
|---|---|
| `submit_research_pi_result` | Advisor：工作综合成熟后恰好提交一次；Executor：成功、真实 blocker 或不可恢复失败后恰好提交一次，禁止用作计划/进度 |
| `research_pi_host` | 请求结构化外部 read/SSH/host command；missing grant 会暂停同一工具调用等待 Pi TUI；Advisor 只允许 read |
| `consult_research_pi` | Advisor 可问能实质改善共同理解的澄清；Executor 只有缺少研究决策或 user-only fact 真正阻塞时才问 |

结果 schema 也是 prompt：

- Advisor：[`codex-advisor-result.json`](../.pi/schemas/codex-advisor-result.json)，字段为 `status`、`shared_understanding`、`points_of_agreement`、`candidate_explanations`、`questions_to_resolve`、`evidence`、`uncertainties`、`working_synthesis`、`suggested_next_exchange`。
- Executor：[`codex-delegate-result.json`](../.pi/schemas/codex-delegate-result.json)，字段为 `outcome`、`goal_satisfied`、`completion_basis`、`summary`、`evidence`、`actions_taken`、`changed_files`、`checks`、`external_effects`、`uncertainties`、`remaining_work`、`recommended_next_step`。

### 7.3 Continuation/steer prompt

复用同一 Codex thread 时不再重发约 3.1k 字符的完整 contract，而发送约 1.0k 字符的 `<research_pi_continuation>`，其中 mission 位于变化的 task 之前，并带 freshness/context delta。其 freshness 核心为：

```text
This continues Codex thread {{threadId}} from job {{jobId}}. {{research-route freshness}} {{Git freshness}}
```

旧 thread 协议不支持动态工具时使用 `LEGACY THREAD REFRESH`，明确“mission/Actor 不变，但对话历史不续接，previous handoff 仅作 orientation”。精确模板见 [`codex-jobs.mjs`](../.pi/lib/codex-jobs.mjs#L383-L421)。

`action=steer` 没有额外包装；`message` 原样作为 Codex `turn/steer` text input，见 [`codex-job-worker.mjs`](../.pi/lib/codex-job-worker.mjs#L653-L680)。`action=respond` 则作为结构化 tool response 回到正在等待的 `consult_research_pi`/host request，不创建第二个用户 prompt。

## 8. 可选 DeepSeek V4 Pro anchor prompt

默认关闭，只针对 `deepseek/deepseek-v4-pro` 且 thinking=max。源码：[`deepseek-v4-pro-anchor.ts`](../.pi/extensions/deepseek-v4-pro-anchor.ts)。

Bootstrap 阶段会把 provider payload 改成：

```text
system: You are a helpful software engineer assistant.
messages: 只保留最后一条 user message
tools:
  bash — Run a command in a persistent shell.
  read — Read a text file.
max_tokens: 1024
reasoning_effort: max
```

`/v4pro-anchor probe` 自动发送：

```text
Inspect the current repository before answering. First determine its top-level structure, then locate and read the project README. Do not guess from prior knowledge. Use the available tools first.
```

首次 assistant/tool event 后进入 promoted 阶段，仍使用 minimal system，但在对话前插入：

```text
<anchored_harness_context>
The following project context becomes available after the V4 Pro bootstrap request.

{{optional Research operating contract}}
{{project instruction files}}
{{skill catalog}}
</anchored_harness_context>
```

`exact` variant 不带 Research operating contract；`research` variant 带。简单解释：这是一条实验性 provider-wire 路径，不应拿它的 prompt 行为代表正常 Research Pi。

## 9. Windows/WSL 分支的额外 prompt

Windows 分支继承上述全部 prompt，只增加 WSL2 权限边界文字。差异集中在：

- [`windows-research-pi:.pi/APPEND_SYSTEM.md`](../.worktrees/windows-sync/.pi/APPEND_SYSTEM.md)：增加“WSL 下只有 opaque SSH target trust 可持久化；host-command/project-script 只能 one-shot；禁止 `/mnt` 和 Windows executable interop”。
- [`windows-research-pi:.pi/extensions/project-boundary.ts`](../.worktrees/windows-sync/.pi/extensions/project-boundary.ts)：`host_capability`、`bash` guidelines 增加相同 WSL 约束。
- [`windows-research-pi:.pi/lib/codex-jobs.mjs`](../.worktrees/windows-sync/.pi/lib/codex-jobs.mjs)：Codex delegation 在 WSL 下增加 one-shot host command 与禁止 Windows/PowerShell executable 的指令。
- [`windows-research-pi:.pi/lib/codex-job-worker.mjs`](../.worktrees/windows-sync/.pi/lib/codex-job-worker.mjs)：Codex 的 `research_pi_host` 工具 description 使用 WSL 专用版本。

这些是条件 prompt：只应在检测到 WSL2 时影响行为。其设计意图是防止 Linux sandbox 通过 `/mnt`、`cmd.exe`、PowerShell 或 WSL interop 触达 Windows host。

## 10. 审阅时建议重点看什么

1. **单一职责**：`APPEND_SYSTEM`、ProjectView、工具 guidelines、Codex prompt 是否各自只表达该层真正需要的规则。
2. **重复与冲突**：同一条安全/证据/续作规则是否在四处出现却措辞略有差异。
3. **事件与上下文分离**：ProjectView delta、mailbox event、普通 tool continuation 是否能被模型清楚区分。
4. **角色升级一致性**：Analysis 的 prompt、工具可见性、执行层权限和 promote 后的 Leader prompt 是否同步切换。
5. **强弱指令层级**：稳定研究原则放 system；一次性状态放 custom message；用户/Actor 内容不得伪装成 system authority。
6. **KV/prefix 稳定性**：稳定 prompt 应尽量字节稳定；动态字段只放在后缀/独立消息，不把轮询状态写入稳定 system 前缀。
7. **证据语义**：工具完成、Codex completion、Runtime delivery、experiment validity 与 Project claim 更新必须保持不同概念。
8. **权限语义**：模型文字、工具 schema、执行层 enforcement 三者要一致；prompt 不是安全边界本身。

## 11. 一句话总览

Research Pi 目前不是“一个 prompt”，而是四个相互作用的状态面：**稳定研究契约、动态 ProjectView、Runtime 消息协议、Codex 子代理协议**；工具和 compaction 则负责把这四个面写入或读取持久状态。审阅时最重要的是减少跨层重复，同时保留清楚的事件身份、证据边界和执行权限 enforcement。
