# Research Pi 手机网页访问

Web 模式为一个 Research Pi 进程提供两种界面：手机对话页和完整 TUI 终端。模型、工具、权限和 subagents 仍由这个 Pi 进程持有；关闭网页不会停止任务。

## 启动

正常安装会准备 Web 依赖。源码安装如果使用了 npm ci --ignore-scripts，再执行：

    npm run setup:web

保存一次偏好，以后在项目里运行 pi 就会自动开启网页：

    pi config web tailscale
    cd /path/to/research-project
    pi

默认每个 workspace 保持一个后台 Pi。电脑终端和手机访问同一进程；再次运行 pi 会重新连接它。Ctrl+] 只断开电脑终端，关闭终端窗口也不会停止后台任务。原生 Pi 的退出操作或 pi web stop 才会结束服务。常驻指本次电脑运行期间持续存活，不包含开机自启；关机后再次运行 pi 启动。

只想后台启动、查看网址或结束服务：

    pi web start --workspace /path/to/research-project
    pi web status --workspace /path/to/research-project
    pi web stop --workspace /path/to/research-project

状态命令输出当前配对链接。--json 可用于读取该服务的机器可读信息，包含私有配对链接。终端的 /web 会向已连接的电脑终端重新打印链接。

一次性启用网页、覆盖配置偏好：

    pi --workspace /path/to/research-project --web-tailscale

从源码目录使用开发版时，入口是 run-pi.sh：

    /path/to/Research-Pi/run-pi.sh --workspace /path/to/research-project --web-tailscale

恢复已有对话时，在相同入口后加 --resume，然后在终端视图选择会话：

    pi --workspace /path/to/research-project --web-tailscale --resume

**不要用直接运行 node bin/pi.mjs 来替代已有的 run-pi.sh 入口。** run-pi.sh 设置 RESEARCH_PI_DEV_MODE=1，读取源码目录的 .env、.pi/agent 和 .pi/sessions。直接运行 Node 入口且未设置该变量时，默认读取用户级配置与状态目录；这可能表现为需要重新 /login、/resume 列表为空。隔离 worktree 的 run-pi.sh 也使用该 worktree 自己的 .pi，不会自动共享原 checkout 的登录或历史。--workspace 选择研究项目，不选择认证和会话存储目录。

默认由系统分配空闲本地端口；Tailscale HTTPS 从 8443 开始选择未占用端口，不覆盖已有 Serve/Funnel。显式指定端口时，端口被占用就报错：

    pi --workspace /path/to/project --web-tailscale --web-port 8790 --web-https-port 9443

只在本机试用：

    pi --workspace /path/to/project --web

单次关闭网页使用 pi --no-web；恢复传统前台生命周期使用 pi --web-tailscale --web-foreground。永久关闭自动开启使用 pi config web off。--print、--mode rpc、--help、--version 和非交互调用不会因为自动配置启动常驻服务。

已有常驻服务时，pi --resume 或带模型等启动参数的再次启动会提示先连接当前服务，在其终端执行 /resume、/model；不会忽略参数或另开一个 Pi 写入同一会话。

终端会打印含临时配对令牌的链接，以及权限为 0600 的 access.json 路径。手机连接当前已登录的同一 Tailscale 账号/网络，打开该链接；也可以打开不含片段的基础地址后手动输入令牌。登录后网页清除 URL 片段，认证使用 HttpOnly、SameSite=Strict cookie，HTTPS 下设置 Secure。令牌和 cookie 随进程退出失效，不要把配对链接发给其他人。

当前会话内的 /web 会把链接重新打印到启动终端，不会写入模型对话。多个标签页访问相同进程；不会创建新 Leader。

网页的令牌配对与模型 /login 是两件事：配对保护远程控制入口，模型认证沿用电脑上这次 Pi 启动所选择的 agent 目录。已有模型登录有效时，手机无需另做一次模型登录。若同时出现重新登录和历史列表为空，先核对启动入口与数据目录，不要复制凭据或搬移会话来掩盖目录差异。

**此入口必须在 Pi 启动时启用。** 它不能接管一个先前未启用 Web 的任意终端进程。不要为访问正在工作的 Leader 同时恢复同一 Session；在下一次计划启动时使用新入口。有活跃任务时不要通过 /reload 升级 Core 或重启 Pi。

## 手机功能

| 手机入口 | 行为 |
|---|---|
| 对话 | 同一 Session 的历史、流式回复、Markdown、图片和工具内容；下一步处理/调整方向；停止当前轮 |
| Agents | 当前 workspace 的 Actor、backend、role、model、thinking、状态和活动；User 身份的消息、提问、回答、steer |
| 项目 | 现有 Runtime 的研究问题、当前判断、证据、下一步、任务状态与 mailbox |
| 模型与设置 | 选择已认证模型与思考强度；完整配置可转入终端 |
| 普通确认 | confirm / select / input 同时显示在手机和 TUI；首个有效回答生效，另一端关闭 |
| 终端 | 原始 Pi TUI，包括 /runtime、/watch、/config、/login、/tree、/resume、/settings、自定义组件、多行 editor 和快捷键 |

聊天页展示最近 160 条可见消息，隐藏的系统/ProjectView 注入不进入网页聊天快照。图片最多 4 张，单张小于 3.5 MB，总大小小于 4.5 MB；更早历史和完整终端行为使用原生 TUI。

手机普通对话走 Pi 原生用户消息 API。Actor 消息走现有 Runtime mailbox；queued、delivered 与任务完成是不同状态，不把入队视为执行成功。Analysis/非所属 Leader 不能通过原生网页控制接口获得额外的调度权限。

终端快捷命令使用原生 Pi 输入路径。存在待处理对话、正在运行的轮次或未发送的终端草稿时，快捷命令不会覆盖它们；在终端中处理后再继续。普通文字输入框支持手机中文输入，虚拟按键包括 Esc、Tab、方向键、Ctrl、Ctrl C、PgUp/PgDn 和 Alt Enter。

“适配屏幕”会调整同一个 PTY 的尺寸，电脑终端也会受到影响。电脑和手机都能输入，不建议两端同时编辑一份输入草稿。停止当前轮不等于取消所有 subagents；后者使用原有 /subagents 等控制入口。

## 连接和权限边界

- 只监听 127.0.0.1，不监听 LAN 或 Tailscale IP，也不启用 Funnel。
- --web-tailscale 只读取当前 Tailscale 登录状态，使用该账号的 DNS、HTTPS 和用户身份。不执行 login、up、账号切换或策略修改。
- 默认要求 Serve 注入的 Tailscale 用户与电脑当前登录用户相同，并且仍需配对令牌。没有身份头的 tagged device 不满足该条件；普通同账号手机可用。
- 启动前检查所选 Serve/Funnel 端口，自动选择空闲端口；显式指定的端口已占用时返回错误，不覆盖或 reset 现有服务。当前账号未启用 HTTPS 时返回说明，不自动修改 tailnet。
- 使用前台 Serve 子进程持有本次端点；正常退出只结束本次 Serve。浏览器断开不结束 Pi 或 Serve。
- API 和 WebSocket 都要求认证；写操作和 WebSocket 校验精确 Origin 与 Host。页面禁止嵌入其他站点、无第三方 CDN，Markdown 经 DOMPurify 清理。
- 临时 IPC socket 位于独立 0700 目录中；常驻服务的访问记录和日志位于 stateRoot/web 下，目录 0700、文件 0600，已排除 Git 和 npm 打包。电脑通过私有 Unix socket 接入同一 PTY。配对信息不进入模型上下文或项目账本，Provider 认证只在电脑使用。
- 网页终端具有和人类本地终端输入相同的权限，包括原生 ! / !! 命令。它不是一个只读结果分享链接。
- 没有后台手机通知或离线操作承诺；手机重新前台显示时恢复当前状态。浏览器重连不会重启模型任务。

常驻模式下关闭电脑终端或浏览器会保留 Pi 与所属 worker；退出 Pi 或 pi web stop 会结束进程和它所属的 Pi/Antigravity worker。--web-foreground 则随启动终端结束。外出访问仍需要电脑保持联网和唤醒。进程重启后的任务恢复能力沿用 Research Pi 现有规则。

## 开发与验证

    npm run check
    npm run test:web
    npm test
    npm run test:package

使用真实 Pi Core + 离线 synthetic provider 检查手机界面：

    node scripts/web-demo.mjs

此脚本使用临时 workspace/config/state，过滤供应商凭据环境变量，不读取正常安装的认证或项目 Runtime；本地端口默认为 8791，可通过 WEB_DEMO_PORT 修改。/web-test-dialog 连续触发确认、选择和文本输入。Ctrl C / SIGTERM 只结束测试子进程并清理脚本创建的临时目录。

实现路径：

- bin/pi.mjs：保留原启动链，按需启用 Web。
- .pi/lib/web-launcher.mjs：一个 PTY、终端状态回放、私有 IPC 与生命周期。
- .pi/lib/web-resident.mjs、web-host.mjs、web-terminal.mjs：每个 workspace 的常驻进程、私有访问记录和电脑终端重连。
- .pi/extensions/research-web.ts：原生 Pi 事件和控制、Runtime 观察、对话桥接。
- .pi/lib/web-server.mjs：网页资产、认证、同源检查、HTTP/WebSocket。
- .pi/lib/web-dialogs.mjs：双端确认协调。
- .pi/lib/web-tailscale.mjs：当前 tailnet 只读检查和本次 Serve 端点。
- web/：无需前端构建步骤的手机界面；静态库从已锁定的本地 npm 依赖提供。

node-pty 1.1.0 的 macOS 预编译 spawn-helper 在本次环境中缺少可执行位；setup:web/postinstall 仅修复这个已确认的问题。Linux 无对应预编译包时，node-pty 正常安装需要原生编译工具。

本功能参考了 Pi Web UI 的同进程接入思路，代码为 Research Pi 独立实现，使用 Pi 官方 Extension API。完整 TUI 经 node-pty / xterm.js 提供，不并发启动另一个 Pi 来读写同一 Session。


## 本次验证记录：2026-10-03

- macOS 本地运行，锁定 Pi Core 1.0.0；syntax checks、255 个 Node tests 和 npm package manifest 检查通过。
- 常驻模式使用真实 Pi Core 与离线 provider 验证：网页发送后收到回复，电脑重新连接能看到同一段历史；Ctrl+] 断开后进程与 Session ID 保持不变，再次启动复用同一进程。另有测试覆盖端口避让、自动开启与 RPC/print 隔离，以及显式停止后的清理。
- WebKit 手机模式：普通对话、中文输入、图片上传与历史显示、模型/思考强度修改、连续 confirm/select/input、完整 Runtime TUI、终端缩放、/reload 与 /new 已验证。离开网页后 Pi 保持运行，返回时恢复已配对的会话与图片历史。原生页隐藏内部 ProjectView，轮询不重建未变化的 Actor 元素。
- 离线 runner 经实际 Runtime mailbox 收到网页 User 消息，回执从 queued 更新到 delivered；不把这视为真实 Codex/Pi/Antigravity 模型质量或远程实验执行的验证。
- 当前已登录 Tailscale 网络上创建过独立前台测试端点：未配对 API 返回 401，配对后返回 200；TLS 证书校验与当前 Tailscale 用户身份校验均保留。
- 本机系统 DNS 对 MagicDNS 主机名返回 ENOTFOUND。测试只在客户端把该主机名解析到当前设备的 Tailscale IP，再保持正确 SNI/证书校验访问成功；未修改系统 DNS、tailnet 设置或登录状态。手机实际的 DNS、蜂窝网络、锁屏恢复还需在真机确认。
- Tailscale 测试进程退出后 Serve 配置恢复为空。生产 Pi 进程、认证、项目 Runtime 未接入测试。
- npm audit 仍报告继承自原基线的 3 个 high 项：sandbox-runtime / node-forge 链及 brace-expansion。新增 Web 依赖没有增加报告项。本次未盲目降级 sandbox-runtime 或更改其权限实现；这些已有依赖问题仍需单独处理。
- 一般 OAuth 登录能从完整终端入口开始，但某些供应商要求电脑浏览器或本机回调；未宣称所有供应商都能仅靠手机完成首次登录。已经登录的 Provider 继续沿用 Pi 的现有认证目录。
