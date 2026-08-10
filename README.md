# Research Pi

Research Pi 是一个面向 AI、通信等计算实验的个人 Pi harness。它使用锁定版本的 Pi Core 和 DeepSeek V4 Flash，并加入轻量的科研行为约束、实验记录、研究 checkpoint 与按需 trace。

## 快速开始

要求 Node.js `>=22.19`。

```sh
git clone git@github.com:RosMarinas/Research-Pi.git
cd Research-Pi
npm install --ignore-scripts
cp .env.example .env
```

编辑 `.env`，填入 DeepSeek 官方 API key：

```dotenv
DEEPSEEK_API_KEY=你的_API_key
```

安装当前用户的命令入口：

```sh
./install-user.sh
```

随后可在任意科研项目中直接启动：

```sh
cd /path/to/research-project
pi
```

更完整的命令说明见 [`docs/pi-basic-guide.md`](docs/pi-basic-guide.md)。

## 命令入口

- `pi`：加载 Research Pi harness。
- `pi-traced`：额外记录模型、工具与时延 trace；trace 可能包含敏感内容，仅按需使用。
- `pi-raw`：直接运行锁定的 Pi Core，用于与 harness 行为进行对照。

安装器默认在 `${XDG_BIN_HOME:-$HOME/.local/bin}` 创建符号链接，不覆盖已经存在的同名文件。

## 默认配置

- Pi Core：`0.84.1`
- Provider：`deepseek`
- Model：`deepseek-v4-flash`
- Endpoint：`https://api.deepseek.com`
- Thinking level：`high`

主要配置位于：

- `.pi/settings.json`：模型、thinking 和 retry 设置。
- `.pi/agent/models.json`：DeepSeek 请求字段兼容配置。
- `.pi/APPEND_SYSTEM.md`：追加到 Pi 默认提示后的科研行为约束。
- `.pi/extensions/`：Research Pi 提供的工具扩展。

运行其他科研仓库时，该仓库自身的 `AGENTS.md` 等项目上下文仍会正常加载。

## Skill 白名单

启动器使用 Pi 原生的 `--no-skills` 关闭全局和项目 skill 自动发现，再通过 `--skill` 只加载经过检查的默认白名单：

- `~/.agents/skills/cognitive-knowledge-network`：研究概念、方法和证据导航；
- `~/.codex/skills/remote-workspace`：远程环境、实验和 GPU 执行。

其他 skills 不会因为存在于 `~/.agents/skills/`、`.agents/skills/` 或 `.pi/skills/` 而自动进入上下文。需要临时启用时，仍可使用 Pi 原生命令行参数：

```sh
pi --skill /path/to/skill
```

白名单 skill 在当前机器不存在时会被跳过并给出提示，不影响 Pi 启动。

## 科研扩展

### `record_experiment`

当一次运行会改变后续研究判断时，记录假设、介入、预期、有效性检查、观察与下一步。记录写入目标科研项目的 `.pi/research/experiments.jsonl`，该文件默认不应进入版本控制。

### `research_checkpoint`

在大步实验修改、回滚或废弃路线前，为当前已跟踪 Git 状态创建独立的研究 checkpoint，不切换分支，也不修改工作树。

### Trace

`pi-traced` 将 trace 写入本 harness 的 `.pi/agent/traces/`。其中可能包含完整 prompt、工具参数和输出；该目录已被 Git 忽略。

## 不安装全局入口

也可以显式指定目标科研项目：

```sh
/path/to/Research-Pi/run-pi.sh --workspace /path/to/research-project
```

按需 trace：

```sh
/path/to/Research-Pi/run-pi-traced.sh --workspace /path/to/research-project
```

## 敏感信息

`.env`、认证信息、session、trace 和本地实验记录均被排除在版本控制之外。仓库只跟踪不含真实密钥的 `.env.example`。提交前检查规则见 [`SECURITY.md`](SECURITY.md)。
