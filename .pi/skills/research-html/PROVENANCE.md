# 来源

这是 Research Pi 的内置 skill，通过启动参数与资源发现机制加载。

- html-plan 1.0.0：anthropics/claude-plugins-community，提交 `06ec7b6a0a82bdc4bec44bd82d4368c42f20d7c1`，目录 `html-plan/skills/html-plan`。
- runtime/htmlplan.css、runtime/htmlplan.js 来自该快照；runtime/pack.mjs 增加中文句末标点、doc-math 与按需离线 KaTeX，并移除上游英文词数、STE 禁词、固定决策数量及推荐必选等文案政策。references/components.md 根据实际 API 精简编写。
- KaTeX 0.19.1：仅携带构建用 JS、CSS、WOFF2 字体，许可位于 runtime/math/LICENSE；没有包含完整 TeX 工具链。
- SKILL.md、references/components.md、runtime/research.css 为本次编写。设计与写作原则已融合进唯一入口，不依赖其他 skill，也不在创作时读取这份来源记录。

上游 plugin.json 声明 MIT，而 marketplace 根目录 LICENSE 为 Apache-2.0。此包保留实际取得的根目录许可（UPSTREAM-LICENSE）和插件元数据（upstream-plugin.json），未替上游推断统一许可。公开分发前应确认 html-plan 的适用许可与署名要求。本地调研和候选适配不代表已完成分发准备。

## 方法参考

以下来源只提炼适用于研究文档的原则，没有将其 skill 作为子 skill 打包：

- Research Pi humanizer-zh（revision 2026-09-23）：保留信息与确定程度，删除真实冗余，自然连贯的中文。
- [Lieflat Charts](https://github.com/larashero3-dotcom/lieflat-charts)：数据形状、视觉编码、记录与聚合；没有复制其 PolyForm Noncommercial 模板或实现。
- [Hyperframes](https://github.com/heygen-com/hyperframes)：颜色、字体与间距角色；没有引入视频工具链或品牌字体。
- [ZCode visualize](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli/packages/visualize-plugin/skills/visualize)：最小有效表示、交互与响应式；没有引入其宿主 API。
- [Anthropic frontend-design / pptx](https://github.com/anthropics/skills)：内容与视觉层级；仅参考方法。
- [Impeccable](https://github.com/pbakaus/impeccable)：清楚的状态文案、术语与字号角色。
- 本地 guizang-ppt-skill：字体分工和信息密度；technical-writing（riekelt/technical-writer）：结论先行与证据来源。

## 随包字体

- Source Han Sans CN Regular/Bold：[Adobe 源码](https://github.com/adobe-fonts/source-han-sans/tree/a4f7cf94edfb9d7ffbdfc4841de276358bd7e0f2/SubsetOTF/CN)，按原字库 30,926 个码位制作 WOFF2 分片。修改后的字体族与 PostScript 名称为 Research Han Sans，以遵守保留字体名要求；字形来自思源黑体。仅改变名称与字符子集。
- Inter Variable：[固定来源](https://github.com/rsms/inter/blob/353b61b9f4430d5f420d56605a6e7993e0941470/docs/font-files/InterVariable.woff2)，原文件。
- JetBrains Mono Regular：[固定来源](https://github.com/JetBrains/JetBrainsMono/blob/19371302b95d218af43299bce79ddbddd0bc364d/fonts/webfonts/JetBrainsMono-Regular.woff2)，原文件。
- 三者均保留取得的 OFL 1.1 原文在 runtime/fonts/；打包后的文档内保留字体许可。思源宋体没有加入默认包。
- scripts/build-fonts.py 是维护用的分片生成器，输入上述原始字体，使用 fontTools/Brotli。普通作者只运行 Node pack.mjs；不会安装或调用 Python。中文粗体有独立 700 字重，Inter 为可变字重，JetBrains Mono 只携带 Regular。

