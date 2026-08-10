# Research Pi 基本使用指南

这份指南面向当前项目里的科研 Pi：Pi 0.84.1、DeepSeek V4 Flash、thinking `high`。安装用户级入口后，日常使用直接输入 `pi`。

## 1. 启动

```bash
cd /path/to/research-project
pi
```

第一次交互式启动若出现 project trust 提示，确认信任本项目的 `.pi` 配置。进入界面后直接输入自然语言任务并按 Enter。

尚未运行 `install-user.sh` 时，也可以从 harness 目录显式启动：

```bash
cd /path/to/research-pi-harness
./run-pi.sh --workspace /path/to/research-project
```

需要原始官方行为或本地 trace 时：

```bash
pi-raw
pi-traced
```

科研 prompt、DeepSeek 配置、四个研究工具和 session 由 harness 提供；文件操作、Git checkpoint 和实验账本作用在启动 `pi` 时所在的研究仓库。所有项目的 Research Pi session 集中保存在 harness 的 `.pi/sessions/`，每个 session header 仍记录其原始工作目录。

Research Pi 默认关闭 Pi 的 skill 自动发现，只加载经过检查的研究白名单。某次任务需要额外 skill 时可显式添加：

```sh
pi --skill /path/to/skill
```

显式路径仍遵循 Pi 的原生 skill 加载与渐进披露机制。

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

`!!command` 会运行命令但不把输出加入模型上下文。生成命令与 extension 都继承当前用户的系统权限；Pi 本身不是 sandbox。

Pi 现在提供四个低摩擦研究工具：

- `record_experiment`：当一个运行结果真正支持、削弱或无法区分研究假设时，Pi 可调用它追加一条 `.pi/research/experiments.jsonl`。普通搜索和调试不会自动记录。
- `research_checkpoint`：在大步替换、回滚或废弃路线前，把当前 tracked Git 状态保存到 `refs/pi-research/checkpoints/...`。它不会切分支或清理工作树，也不会捕获 untracked 文件。
- `research_memory_search`：在旧 session 和实验记录中进行本地全文检索；默认仅限当前 Git 项目，并排除当前 session 和废弃分支。
- `research_memory_read`：根据搜索结果中的 session/entry ID 读取精确原文和小范围上下文。

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

## 4. 会话、分支和恢复

普通会话会自动保存到 Research Pi harness 的 `.pi/sessions/`，而不是散落在每个科研仓库中。历史检索依据 session header 中的 cwd/Git 根目录区分项目。

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
| 查看最近结构化科研状态 | `/research-state` |

科研中推荐这样区分：

- 竞争假设 A/B 仍属于同一问题：使用 `/tree`，保留在同一会话树中；
- 已经切换成新的研究问题或正式实验阶段：使用 `/fork` 或 `/new`；
- 会话很长但仍在解决同一问题：使用 `/compact`。Research Pi 保留约 65,536 tokens 的 recent tail，并把竞争假设、有效性、evidence refs 与下一实验写入结构化 compact；完整 JSONL 历史仍保留。
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

真实仓库同样支持 `--workspace`。trace 写入 harness 的 `.pi/agent/traces/`，输入 `/trace` 可生成并打开 HTML。trace 保存完整 prompt、工具参数和输出，不要在包含未脱敏秘密的任务中随意启用或分享。

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
- Pi 会修改文件和运行命令，但没有内置安全隔离；
- memory SQLite 是派生缓存，不进入 Git；它会脱敏常见凭证形式，但原始 session、实验账本和不常见秘密格式仍是敏感数据；
- 当前 65,536 recent-tail 配置是初始值，256K/384K/512K 软 compact 阈值尚待真实长任务对照后决定；
- 当前适合受监督科研探索，极限上下文、长期多分支召回和无人值守远程执行仍未完整验证；
- 先让真实任务暴露摩擦，再加入 extension 或工作流，不预先安装全家桶。
