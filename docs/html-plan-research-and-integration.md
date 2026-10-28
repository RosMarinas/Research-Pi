# html-plan 调研与 Research Pi 整合建议

建议将 html-plan 的文档结构与交互 runtime 适配成 `research-html`：以流程图为重点，中文解释配英文技术关键词，采用用户截图中的目录、折叠层级、暖白底和克制强调色；中文文案以 Pi 现有 humanizer-zh 为基础。数学公式使用 LaTeX，并提供离线资源。

当前已将 research-html 接入主分支的 Research Pi 内置 skill 列表，并随包提供正文字体与数学资源。没有执行 Claude 全局插件安装，也没有新增 viewer 服务。

## 1. 已取得的源码与样例

- 上游：[anthropics/claude-plugins-community/html-plan](https://github.com/anthropics/claude-plugins-community/tree/06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1/html-plan)，plugin version 1.0.0。
- 固定提交：`06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1`。
- 原始 skill 下载到 `/tmp/research-pi-html-plan-01a17cf1/html-plan`，包含 SKILL.md、blocks.md、示例和三个 runtime 文件。
- 当前实现位于 `.pi/skills/research-html/`；此前临时目录保留为调研阶段快照。
- [原始下载归档](../output/html-plan-study/html-plan-upstream.zip)、[当前 skill 归档](../output/html-plan-study/research-html.zip)、[中文交互预览](../output/html-plan-study/research-pi.html)。

用户提供的 Claude Artifact 链接返回访问验证 403。后来提供的截图清楚展示了参考布局，且其 Scheduled Send 内容与上游示例相符。视觉判断基于该截图和已下载 CSS，不声称取得了线上 Artifact 的全部源码或精确字体。

## 2. 原 skill 规定了什么

[SKILL.md](https://github.com/anthropics/claude-plugins-community/blob/06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1/html-plan/skills/html-plan/SKILL.md) 定义的是交互式实现计划：

| 层次 | 内容要求 | 主要展现方式 |
| --- | --- | --- |
| 文档标题与 Why | 名称与用户原始需求 | 标题、折叠引文 |
| What | 可观察行为或保证 | mockup、状态机 |
| How | 入口、规则或数据记录 | 调用树、schema、代码片段 |
| Where | 实际实现位置 | 文件路径、行号、源码 |

顶层按行为拆分，折叠后的标题构成摘要。每个论点通常只放一个展现块，最多三层、每层不超过五个子项；重要选择放在它影响的论点旁。真实代码要引用实际路径和行号，尚未存在的代码标为草图。

它还要求全篇使用 ASD-STE100 简化技术英语，建议每页 2–5 个决策，并规定收到用户反馈后才开始实现。这些是上游的工作流选择，不适合作为 Pi 的普遍约束。

[blocks.md](https://github.com/anthropics/claude-plugins-community/blob/06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1/html-plan/skills/html-plan/references/blocks.md) 解释了 `doc-machine`、`doc-flow`、`doc-seq`、`doc-calls`、`doc-schema`、`doc-code`、`doc-mock` 等组件。节点与代码行可以关联评论，schema 可以编辑，调用项可以划去，最终生成一份 Markdown 反馈。

## 3. runtime 的实际能力和边界

原版使用 Node 内置模块进行打包，没有 React、构建框架、服务端或独立 npm 依赖。浏览器端 JS/CSS 负责绘图、展开、评论和反馈；pack.mjs 把 runtime、部分本地媒体和代码片段内联。

浏览器端将回答、评论和编辑保存在 localStorage，key 使用路径与标题。反馈是复制回聊天；源码明确关闭了 live send，不存在现成的 agent 回传 API。仅显示过某个选择也不等于用户批准。

打包器有路径边界与常见敏感文件检测，但它是文档构建器，不是任意 HTML 的安全隔离层。外链媒体会保留，较大的本地媒体可能不内联，普通 CSS 中的字体 URL 也不自动递归打包，因此“已 packed”并不普遍保证完全离线。

原版没有 LaTeX 数学渲染。`doc-code lang="latex"` 只能展示源码，不能替代公式排版。

## 4. 语言风格的取舍

已检查以下来源的原文，按用途提炼，不把它们整套叠加成强制流程：

| 来源 | 采用的重点 | 不照搬的部分 |
| --- | --- | --- |
| [Pi 的 humanizer-zh](/Users/polaris/Documents/Utils/Pi/.pi/agent/skills/humanizer-zh/SKILL.md) | 保留事实和确定程度；删除空话、重复和歧义；保留自然中文衔接与技术术语 | 不搬入 31 项逐条扫描仪式，也不要求已通顺的文字必须改 |
| [Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | 内容决定视觉；文字帮助读者理解和操作；动作和术语一致；明确用户参考优先 | 不追求商业 hero、营销表达或刻意新奇的视觉 |
| [Impeccable clarify](https://github.com/pbakaus/impeccable/blob/main/skill/reference/clarify.md) | 每个状态先说最需要知道的事实，说明可用操作及必要条件；标题和正文不重复 | 不为润色新增审批或流程 |
| [Impeccable typeset](https://github.com/pbakaus/impeccable/blob/main/plugin/skills/impeccable/reference/typeset.md) | 稳定的字号角色、阅读宽度、中文/英文回退及缩放可读性 | 不引入完整设计系统与检测平台 |
| [Anthropic pptx](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md) | 主次明确、视觉焦点、留白、真实渲染检查 | 它侧重演示制作，不是中文写作标准；“每页必有图”等要求不适用于所有 HTML 段落 |
| [本地 guizang-ppt-skill](/Users/polaris/.agents/skills/guizang-ppt-skill/SKILL.md) | 字体分工、内容选择版式、装不下先改写或分层；术语保持一致 | 不强制金句、中文标题五字限制、极端字号或拒绝用户自定义配色 |
| [technical-writing](https://github.com/riekelt/technical-writer/blob/main/plugins/technical-writer/skills/technical-writing/SKILL.md) | 结论先行、来源可追溯、文档保持原语言 | 不照搬全部禁词、段数和文档管理规则；该仓库规模较小，仅作补充参考 |

检索同时查看了 skills.sh/CLI 与仓库。CLI 显示 technical-writing 约 19.1K installs，但其仓库 API 仅返回 33 stars；安装数不能替代内容判断。这里采用的是具体可核查的方法，不是基于热度推荐整套安装。

候选 skill 将文案分成四个层次：标题说判断，节点标概念，图注说关键关系，展开层放依据。正文默认中文，用户指定时用英文。图中保留 `scheduled`、`running`、`retry`、`batch` 等技术关键词；不将句子写成无必要的中英杂糅。

humanizer-zh 的优先级最高：任何“更简洁、更有力”的措辞都不能改变否定、范围、条件、时间、归因或完成状态。不把“可能有效”改成“有效”，不把“计划验证”改成“已验证”，不为具体感制造数字。

## 5. 参考截图如何落地

保留左侧目录、层级编号、可折叠标题、图下状态条和对应内容面板。主文列给流程图足够空间，详情按需要展开；窄屏收起目录或允许图局部横向滚动。

上游 CSS 的核心颜色为暖白 `#faf9f5`、白色内容面 `#ffffff`、深灰 `#141413` 和陶土橙 `#c6613f`。这些是源码值，不是从截图反推的精确色值。强调色服务当前状态、交互和重点；分支颜色需有清楚语义，不能用成功色暗示尚未验证的收益。

文档主标题可使用衬线；正文和节标题采用中英文无衬线；图关键词与代码用等宽。当前已内置思源黑体衍生分片、Inter 与 JetBrains Mono，并保留系统回退；打包时按页面字符选择分片。未携带参考产品的私有品牌字体。

流程图为重点：显式布局、简短英文状态/事件、中文解释、清晰的失败/终止分支。浏览器检查中曾发现一条长回路标签被裁切，已重排为更清晰的五状态图，并缩短箭头标签。

## 6. LaTeX 与可携带资源

候选增加 `doc-math`，接受 text/plain 内的 LaTeX；行内可写 `\(...\)`，独立公式可写 `\[...\]`。它不自动扫描整页任意美元符号，不处理代码块中的伪公式。

按 [KaTeX 的 Node 使用方式](https://katex.org/docs/node)，构建时预渲染 HTML/MathML，浏览器只需要样式和字体，无需再运行公式 JS。候选携带 KaTeX 0.19.1 构建文件、CSS、WOFF2 字体及原始许可，出现公式时才加载并内联。保留数学源码与可访问的 MathML。

KaTeX 支持的是其覆盖的 LaTeX 数学语法，不是完整 TeX 文档。特殊宏超出支持范围时，再考虑 [MathJax](https://www.mathjax.org/) 或其他明确适合的路径，不静默交付未渲染字符串。公式附近用中文说明变量含义和适用条件。

## 7. 候选 skill 与 Pi 接入方式

```text
research-html/
  SKILL.md                 唯一创作规范：内容、语言、流程图、图表、排版、数学
  references/
    components.md          组件 API，按所需语法查阅
  runtime/
    htmlplan.js
    htmlplan.css
    research.css
    pack.mjs
    fonts.mjs              根据文档字符内联所需分片与许可
    fonts/                 思源黑体衍生分片、Inter、JetBrains Mono
    math/                  KaTeX、CSS、WOFF2、LICENSE
  scripts/build-fonts.py    维护时重建字库，普通作者无需 Python
  examples/research-pi.html
  PROVENANCE.md
  UPSTREAM-LICENSE
  upstream-plugin.json
```

本轮已将 writing、visual-style、charts 与原 blocks 中的创作规则合并为一个 SKILL.md，删去这四份旧参考文件；组件语法另行精简为 components.md。Agent 不必加载 humanizer-zh、Lieflat、Hyperframes 或 ZCode 等子 skill，也不必阅读来源调研；来源仅保留在 PROVENANCE.md 与本文。打包器同步移除英文词数、标题形式与 STE 禁词等上游政策，避免工具警告与统一文风冲突。

现在作为内置普通 skill 使用，不新增 agent 角色。Leader 在需要 HTML 研究说明/计划时选择它；实现可交给现有 executor，Systems Optimizer 只在其任务需要可视化时使用。

Research Pi 的 `bin/pi.mjs` 已支持额外 skill 路径；`.pi/extensions/research-config.ts` 在 resources_discover 时读取 `resources.skills`。本次已在启动参数和 resources_discover 中加入包内 research-html，可通过 `/skill:research-html` 使用；运行本 checkout 的旧 Host 可在空闲时 `/reload`。不需要 Claude 的 marketplace 管理器。

子代理必须实际收到相关指令和资源位置，不能假设 Leader 加载就等于所有 backend 自动继承。按需传入 skill 或相关正文，并在已有权限内提供 runtime 资源；不向所有角色的常驻提示词灌入整个组件手册。

交付先采用单文件 HTML + 独立浏览器 + 复制反馈。Pi 当前 web-server.mjs 只提供固定资产路由，CSP 也不允许任意内联脚本；它尚不是 HTML artifact viewer。如果之后需要内嵌预览或“发送反馈给 Pi”，再设计隔离的预览与显式提交通道，不为方便直接放宽整个终端页面的权限。

候选已删除原版的固定 2–5 个决策和必等反馈约束，允许纯说明与零决策。默认选项不是授权。已授权工作不因生成 HTML 自动暂停。

短控件如 `Contents`、`Respond`、`Copy response` 当前沿用原版英文；这是候选的现状，完整控件本地化尚未实现。正文、图注与状态解释默认中文。

## 8. 实际检查与边界

- 上游 Scheduled Send 示例成功打包，约 218 KB；六条警告来自示例项目代码不在下载目录，未将其当作 Pi 真实源码。
- 浏览器中验证了折叠展开、跳转到决策、将选项从 50 改为 500、生成反馈。反馈保留了更改和其他未打开默认项的区别。
- 调研阶段的中文候选示例成功打包，未嵌入正文字体时约 578 KB，包含英文状态图、中文说明和预渲染 LaTeX。候选修正了英文句末检查对中文句号的误报，并识别公式内容块。
- skill frontmatter 校验通过。浏览器视觉检查用于发现节点、箭头标签和公式布局问题；这些检查不等于已验证完整跨浏览器支持或已接入 Pi viewer。
- 原始下载和 fontTools/Brotli 维护环境位于临时目录；字库、许可和文档 runtime 随 skill 发布。package.json 没有新增运行依赖，已有 Systems Optimizer 实现没有因此改变。

上游 plugin.json 声明 MIT，marketplace 根目录 LICENSE 为 Apache-2.0；候选保留两处原始信息，没有自行把所有文件归成同一许可。公开分发前需确认 html-plan 的适用许可与署名要求；其他写作 skill 只参考方法，没有把其实现复制进包。

## 9. 追加参考：Lieflat、Hyperframes 与 ZCode visualize

| 来源 | 对候选 skill 的补充 | 接入边界 |
| --- | --- | --- |
| [Lieflat Charts](https://github.com/larashero3-dotcom/lieflat-charts) | 按数据形状选图，保留单位/来源，统一视觉编码，区分记录与聚合；已融入 SKILL.md 的数据图表规范 | LICENSE 为 PolyForm Noncommercial；本候选只提炼通用原则，没有复制模板或实现。也不强制它的模板审计顺序和动画默认值 |
| [Hyperframes DESIGN.md](https://github.com/heygen-com/hyperframes/blob/main/DESIGN.md) 与 design-systems 文档 | 明确的颜色、字体、间距角色，安静的面板和边框，遵循已有参考；已融入 SKILL.md 的排版规范 | 框架主要将 HTML 渲染成视频，另有 slideshow；普通阅读页不安装 FFmpeg/视频栈，也不把视频动效和大字号直接移植过来 |
| [ZCode visualize](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/visualize-plugin/skills/visualize/SKILL.md) | 选择最小有效表现形式，展示交互保持本地，图表重排与标签可读性、单位及区间表达、键盘/触屏支持 | 它面向宿主内联 HTML fragment，依赖主题、状态与消息 API；Research Pi 不能直接使用 window.zcode 或其内联引用协议 |

这些参考各自解决不同问题。当前候选仍以 html-plan 的文档骨架和用户截图为视觉主线，以 humanizer-zh 保护中文含义，以 KaTeX 处理 LaTeX；创作规则已融合为一个入口，只有具体组件语法需要时才查 components.md；不会按来源串联多个 skill。没有为展示这些风格添加虚构的实验图表。

ZCode 对“独立文档”和“对话内组件”的区分尤其有价值：前者需要正文、引用、公式和可携带文件；后者需要宿主适配。当前完成前者。保存选择、发送追问和执行实验必须分开，不能把浏览器里的一个选择自动升级为 agent 指令。

## 10. 正式接入与字体效果

默认方案已实现：主标题、正文和普通节点使用思源黑体 + Inter，代码/事件使用 JetBrains Mono；公式继续由 KaTeX 排版。思源黑体 CN 以 Regular/Bold 两个字重分片，改名为 Research Han Sans 并保留 OFL，原字体的 30,926 个码位仍在资源包中。Inter 为可变字体，JetBrains Mono 携带 Regular。原始来源的固定提交见 skill 的 PROVENANCE.md。

整套 WOFF2 字体约 15 MiB，随安装包保存；普通生成不需要联网或 Python。pack 根据页面字符选择中文分片，内嵌到单文件 HTML，同时保留字体许可。本示例约 3.7 MiB；这不是逐字最小子集，换成更长的内容时大小会变化。系统字体仍用于字库外文字和阅读后新输入、未嵌入字形的回退。

已完成以下与接入直接相关的检查：

- Pi Core 的真实 skill loader 成功发现 research-html，无 diagnostics；skill frontmatter 校验通过。
- 配置测试 12 项通过，其中验证 /reload 能发现内置 HTML skill、保留外部 allowlist 并去重。
- npm 发行包检查通过，包含 runtime、字体分片、许可和 KaTeX；无新增 npm 依赖。
- 浏览器检查了 1440px 和 430px 视口、状态切换与公式。Chromium 实际字体查询确认中文标题/正文使用 Research Han Sans，英文节点为 Inter，事件标签为 JetBrains Mono；均为嵌入字体。

Systems Optimizer 与 research-html 已一起合并到 main。主目录此前的其他开发修改继续保持未提交状态；没有重启运行中的 Host 或发布 npm 包。
