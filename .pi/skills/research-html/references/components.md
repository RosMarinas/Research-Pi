# 组件语法

按所需组件查阅。这里仅说明本包 API，创作规范统一在 SKILL.md。

## 页面与章节

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>实验优化</title>
<link rel="stylesheet" href="../runtime/htmlplan.css">
<link rel="stylesheet" href="../runtime/research.css">
</head>
<body>
<header><h1>实验优化</h1></header>
<doc-plan open="1">
  <doc-claim id="pipeline">
    <p>先测量完整流水线的等待。</p>
    <doc-note tone="info">解释、证据或流程图放在这里。</doc-note>
  </doc-claim>
</doc-plan>
<script src="../runtime/htmlplan.js"></script>
</body>
</html>
```

资源路径按源 HTML 所在位置调整。`doc-plan open="0…3|needs"` 控制初始展开层数，默认 `0`；`needs` 展开通向决策的分支。`doc-claim` 的第一个 `<p>` 是标题，后面是内容和可嵌套的子 claim。`id` 提供锚点，指向关闭章节的链接会展开路径；`aux="shared|scope"` 为不编号的末尾章节，`at="path:line"` 可关联调用行。

## 文本 DSL

图与代码的源文本放在第一个 `<script type="text/plain">` 子节点，避免 `<` 被解析成 HTML。行首 `+`、`-`、`~` 在支持的组件中分别表示新增/提议、删除、改变；这些标记描述变更，不表示实测结果。

### 状态机 `doc-machine`

```html
<doc-machine name="run" caption="点击状态查看说明。">
<script type="text/plain">
machine run initial ready
state ready        # 输入已经准备完成。
state running      # 当前 batch 正在执行。
state done final   # 结果已保存。
state failed final # 执行失败；保留原因。
| ready | running | done |
| .     | failed  | .    |
ready   -start-> running : batch
running -ok-> done : saved
running -error-> failed : error
</script>
<div data-state="ready"><p>此处可放对应界面或证据。</p></div>
<div data-state="failed"><p>此处解释失败条件。</p></div>
</doc-machine>
```

`state id [final] # 说明`；`from -event-> to : label`。网格 `.` 留空；无网格时自动布局。`+`/`-` 用于边。非终态需要可达的后继；打包器检查不可达状态和非终态死路。`data-state` 面板随点击切换，`data-if="run=failed"` 可控制页内条件显示。

### 数据与组件流 `doc-flow`

```html
<doc-flow caption="CPU 准备输入，再交给 GPU。">
<script type="text/plain">
cpu = CPU worker
queue = Batch queue
gpu = GPU
| cpu | queue | gpu |
cpu -> queue : ready
queue -> gpu : H2D
</script>
</doc-flow>
```

节点 `id = label / sublabel [shape color]`，边 `a -> b : label`，虚线 `a --> b`；网格同上。常用形状 `box`、`pill`、`diamond`、`db`，颜色 `green` 等为运行时内置样式。

### 时序 `doc-seq`

```html
<doc-seq caption="图示调用顺序，不代表实测耗时。">
<script type="text/plain">
participants: cpu "CPU worker" gpu "GPU"
cpu -> gpu : submit batch
gpu --> cpu : result
note over cpu, gpu : 同一 batch
</script>
</doc-seq>
```

## 代码、调用与数据结构

- 已有代码：`<doc-code src="path.py" lines="20-34" hl="27"></doc-code>`。`--root` 决定读取根目录；`ref="commit"` 可读 Git 版本。
- 提议代码：`<doc-code title="worker.py · sketch" lang="py"><script type="text/plain">…</script></doc-code>`。
- `diff file="path"` 接受 unified diff，`start="N"` 指定起始行，`wrap` 换行，`collapsed` 默认折叠。`<doc-pin line="27" title="说明">补充内容</doc-pin>` 定位行；删除行用 `old="N"`。
- `doc-schema` 接受同样的 text/plain 或 `src`/`lines`，需 `lang="sql|ts|json|py|…"`，`id` 用于保存本页编辑；`diff` 表示变更。
- `doc-calls` 的每行是调用，行首标记后空格缩进表示层级，每级两空格；`@ path:line` 关联源码，`-- 说明` 为行尾注释。示例：`~ run() @ worker.py:20` 与下一行 `+   prepare() @ worker.py:8`。`**symbol**` 标识新符号，`?` 表示可讨论的提议调用。

## 界面与说明

`<doc-mock frame="none" w="440"><template>实际 HTML</template></doc-mock>`：支持 `none|browser|phone|desktop|terminal` 边框，`w` 是设计宽度，`h` 裁剪高度，`caption` 图注。mock 在 shadow root 中显示，样式放在 template 内；页面级 `<style data-mock-shared>` 可共享样式。`data-ref="name"` 和 `<doc-pin ref="name" title="说明">…</doc-pin>` 关联标注。

已有界面截图用 `<doc-shot src="image.png"></doc-shot>`。说明用 `<doc-note tone="info|warn|risk|ok|idea">…</doc-note>`。原文引语用 `<doc-quote via="prompt|github|doc|…" from="来源" href="链接">原文</doc-quote>`；这些属性描述来源，不改变引用内容。

## LaTeX

```html
<doc-math><script type="text/plain">
\[S = \frac{T_{\mathrm{base}}}{T_{\mathrm{opt}}}\]
</script></doc-math>
<doc-math inline><script type="text/plain">\(N > 0\)</script></doc-math>
```

`inline` 选择行内公式，否则使用独立公式。运行 pack 后才得到已渲染数学内容；不支持的数学语法会报错。

## 可选反馈 `doc-ask`

```html
<doc-ask id="cache">
<p>缓存放在哪里？</p>
<label><input type="radio" name="cache" value="ram" checked> RAM</label>
<label><input type="radio" name="cache" value="disk"> Disk</label>
</doc-ask>
```

支持 radio、checkbox、命名 textarea/input/select。不同问题的控件名需独立；同组 radio 共享 name 且各有 value。`checked` 为展示的推荐默认值，不是用户同意。`data-if="cache=ram"` 可显示条件内容，也支持 `!=`、`~`、`&&`。页面生成 Markdown 反馈供复制回聊天。

## 打包

`node runtime/pack.mjs source.html --root <project> -o output.html`；`--lint-only` 只检查。错误阻止写出，警告按实际布局判断。路径与组件检查不验证实验结论。打包时源码引用会成为 HTML 内容，命令会列出嵌入的源文件。
