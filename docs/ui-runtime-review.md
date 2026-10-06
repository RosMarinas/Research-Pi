# UI 与 Runtime 分离：实现与验收

2026-10-06，开发分支 `codex/runtime-ui-separation`。当前保留在独立 worktree，用户验收后才合并、推送和删除 worktree。没有接管或重启主项目中正在使用的 Pi。

## 实际结构

```mermaid
flowchart LR
  TUI[本机 TUI 客户端] -->|私有 Unix Socket| Host[独立 Runtime Host]
  Desktop[本机 Web 客户端] --> Gateway[独立 Web Gateway]
  Phone[手机 Web 客户端] -->|当前 Tailscale HTTPS| Gateway
  Gateway -->|同一个协议| Host
  Host --> Pi[原生 AgentSessionRuntime]
  Pi --> Session[原生 Session JSONL]
  Pi --> Research[Research 扩展、权限、Ledger、Subagents]
```

Host 是模型循环、工具、权限、交互和会话的唯一拥有者。TUI 不加载第二个 AgentSession，Gateway 不拥有终端或模型。关闭所有界面、调整窗口、关闭或重启 Gateway 都不停止 Host。只有 `pi runtime stop` 或 Host 收到终止信号才结束运行时。

参考本机 DeepSeek Harness 的窄客户端契约、Host Session 投影、快照重连和事件序号设计：`packages/client/runtime/src/client/contract/session.ts`、`packages/client/runtime/src/client/sessions/session.ts`、`packages/host/apiproxy/src/api/events.ts`。该实现中的 `since` 未实现，不能照搬成事件重放保证。本实现使用内存中的 256 条 / 2 MiB 有界事件环；游标过期、Host 重启或会话 epoch 改变时必须重取快照。原生 JSONL 保留会话历史，事件环不是第二份持久数据库。

## 使用

```bash
# 设置本机网页偏好，然后在目标项目启动；再次运行会连接同一个 Host
pi config web local
pi
# 不开启网页
pi --no-web
# 只启动后台 Host 和网页
pi runtime start
# 后台 Host 不开网页
pi runtime start --no-web
# 查看访问链接（首次配对后浏览器保留会话 cookie）
pi web status
# 关闭网页服务；模型和工具仍在 Host 中运行
pi web stop
# 再次开启网页服务
pi web start
# 显式结束 Host
pi runtime stop
# Analysis 使用单独的 Host；不会复用 Leader 启动参数
pi --analysis
# 原生旧界面兼容路径
pi --legacy-ui
```

默认本机网页仅监听 loopback，自动选择空闲端口。手机端继续使用已有 Tailscale Serve 和当前登录身份；未开启 Funnel，未改动 tailnet 身份。工作区无关的持久配对 token 沿用已有实现，原始 token 和提供方凭据不会进入版本库。`--web-port`、`--web-tailscale` 等原有网页参数保持可用，具体参数见 [手机网页说明](mobile-web.md)。

启动选项只能用于创建 Host。已有 Host 上的模型和会话切换使用 `/model`、`/resume` 等操作；若要改变启动资源，应先保存并显式停止 Host。发现旧 tmux resident 时新 Host 会拒绝启动；先用旧路径继续使用，在空闲后再迁移，防止两个写入者同时管理会话。

TUI：`Ctrl+]` 分离，`Ctrl+C` 中止当前轮，`Ctrl+D` 退出客户端，`Ctrl+P` 模型选择，`Ctrl+O` 思考块，`Ctrl+E` 工具展开，`Alt+Enter` steer，`PgUp/PgDn` 历史翻页；Host 连接丢失后 `Ctrl+R` 重连。

本机网页有会话侧栏、对话、Agents、项目和操作页；手机自动使用窄屏布局。原生 `/model /thinking /resume /new /clone /import /tree /fork /compact /login /logout /settings /session /name /export /copy /reload /trust` 由 Host 执行。Research 的 `/runtime /watch /config /models /side` 等命令沿用原扩展；`/queue` 查看队列，`/queue clear` 清空。技能和提示模板沿用 Pi 原生展开。

## 本次隔离验收

在 worktree 执行：

```bash
node scripts/runtime-demo.mjs         # 创建隔离工作区和离线合成 provider
node scripts/runtime-review.mjs open  # 私下读取配对链接并打开系统浏览器
node scripts/runtime-review.mjs tui   # 同一 Host 的 TUI
node scripts/runtime-review.mjs status
node scripts/runtime-review.mjs stop  # 只关闭本次隔离验收服务
```

`output/runtime-review/access.json` 是权限为 0600 的本地私有指针，已被 Git 忽略。不要分享或提交它。验收 provider 不调用付费模型，31 个历史 Actor 和一个消息回环 Actor 是测试数据。

建议检查：

1. 在 Web 发消息，TUI 同时显示同一历史；关闭其中一个界面后另一个继续工作。
2. 在网页或 TUI 输入 `/web-test-dialog`，看到审批后关闭界面，再从另一界面回答同一个请求。
3. 使用 `/models`、`/config`、`/side collapse`、`/resume` 和 `/fork`；会话恢复显示已有内容，fork 将待编辑文字放回输入框。
4. Agents 页打开 `pi:web-demo`，发送文字，查看投递回执和“已通过 Runtime 收到”回复。历史长名称卡片可完整展开，不应互相覆盖。
5. 本机 1440 像素与手机 390 像素宽布局；手机键盘缩小视口后输入框与列表正常。
6. TUI 缩放和分离不影响 Host；网页重开后历史和待处理交互仍可恢复。

## 正确性边界与验证

Host 使用请求 ID 去重，Session ID 和 epoch 防止旧界面修改新分支；两个客户端回答同一审批只有第一次有效。交互保存在 Host，UI 断开不会默认允许或取消权限。普通输入在原生 preflight 确认为 started/queued/handled 后返回；交互式命令等待完成，不能与下一条输入并发越过。Actor 写入要求当前 Session 拥有 Leader，Analysis 不能通过网页绕过原有限制。

公开历史隐藏 system/developer 消息和内部上下文。历史分页只影响客户端显示，不截断模型上下文。离线请求捕获验证 UI 读取、视图和重连不会改变下一次请求已有消息前缀、系统提示或工具集合；这不保证提供方的服务端缓存命中或驻留时间。模型选择、压缩和原有 Research 业务逻辑仍由 Pi/扩展负责。

测试：`npm run check`、`npm run test:runtime`、`npm test` 和 `npm run test:package`；浏览器用 WebKit 检查桌面、手机和短视口，真实 PTY 检查 TUI 缩放、帮助和分离。模型调用和审批使用合成 provider；没有重新进行真实 OAuth 登录或付费模型请求。

UI 只上报是否有草稿的短期状态，用于保留既有“用户输入时暂缓自动接入 Leader”的行为；草稿正文不进入模型上下文或 Ledger。

第三方扩展任意 `ctx.ui.custom()`、自定义 Editor 或 Autocomplete factory 是进程内函数，不能直接穿过 Socket。新客户端会明确要求视图适配，不假装支持；本仓库 Runtime、Watch、模型和配置的必要视图已接入。旧界面仍可用 `--legacy-ui`。新 TUI 复用原生消息、Markdown、Editor、选择器以及 Watch/Runtime 面板，但不是原生 InteractiveMode 的逐像素复制。

请求去重与待处理交互在 Host 内存中，不提供 Host 崩溃后的 exactly-once 执行承诺。浏览器重连使用当前快照；Gateway 在 Host 不可达时标记状态未知、拒绝操作，重新连接后重取状态，不自动重发变更请求。原生历史 JSONL 和现有 Ledger 仍是持久事实来源。

### 本次实测结果

- 完整 `npm test`：275/275 通过，其中 Host 相关 16 项覆盖断线审批、去重、epoch、请求前缀、模板、草稿恢复和 Gateway 重连。
- `npm run check` 与 npm 打包验证通过。
- WebKit：桌面会话侧栏、新建后快速恢复历史、模型筛选；32 个长名称 Actor 无重叠；390×420 短视口输入区可见；Actor 消息投递回环成功；刷新后审批 ID 不变。
- 真实 PTY：帮助、模型选择、100×30 → 52×16 缩放和 Ctrl+] 分离成功；退出码 0，Host 保持可连接，无遗留审批。
- 隔离 CLI：关闭/重开 Gateway 保持 Host PID；单独启动无 Web 的 Analysis Host，原 Leader 保持，Actor 写操作被拒绝。

上述结果来自 macOS、固定 Pi 1.0.0 和离线合成 provider；没有把它当作真实提供方 OAuth、服务端缓存命中或所有第三方 UI 扩展的验证。
