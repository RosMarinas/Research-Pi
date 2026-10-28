# GPU 训练与实验基础设施优化：现有方案调研

调研日期：2026-10-27。范围是训练应用层和运行时编排优化：让 CPU、数据输入、多个 GPU、通信和多 batch 更好地并行，减少 launch、同步、排队和流水线空泡。重点查看原始文档、官方仓库和论文；不运行 GPU 实验。

用途说明：本文是偏 GPU/训练生态的工具背景调研，不是通用系统性能工具的完整调查。根据用户随后补充，Research Pi 的 agent 应从整个实验系统分解问题，覆盖 CPU 计算、内存、I/O、IPC、CPU–GPU 通信、GPU 计算与后处理，以优化我们编写的实验代码为主。SGLang、vLLM 在这里代表成熟公开库函数，对这些库内部实现的优化优先级最低。综合方案见 [实验系统优化代理设计](gpu-experiment-optimizer-design.md)。

## 结论

现有生态已经覆盖了这个问题的若干重要部分，但还没有找到一个能跨 Research Pi 的任意研究代码，自动完成“发现串行小任务/小 batch → 改成并行批处理或流水线 → 在目标机器上验证任务语义和端到端速度”的通用成熟 agent。

最接近的完整设计是 AMD Primus Tuning Agent：它在一个受支持的训练栈内，把并行度、micro/global batch、pipeline schedule、通信重叠、重计算、精度和内存约束作为联合搜索空间，用 projection/benchmark 作 evaluator。分析环节最值得参考的是 HTA、AMD TraceLens 和 Nsight Systems/Compute；前两者从 trace 中量化空闲、通信、计算和 rank 差异，TraceLens 还生成系统层建议。它们提供诊断依据，不等同于能安全地重构任意训练脚本的自主优化器。

目前工具的边界大致分成三类：**profile/trace 诊断**、**固定训练栈的配置搜索**、**GPU kernel 代码生成优化**。Research Pi 的机会在第一、二类之间，能将识别到的 CPU 主导或小任务串行模式变成可验证的代码/执行计划实验；kernel 优化可作为后续分支，不应成为主循环。

## 候选方案

| 方案 | 已有能力 | 与 Research Pi 目标的关系及缺口 |
| --- | --- | --- |
| [AMD Primus Tuning Agent](https://rocm.docs.amd.com/projects/primus/en/v26.8/02-user-guide/tuning-agent.html) | LLM 提议候选，代码检查配置合法性，按预算迭代；搜索 TP/PP/EP/CP、VPP、micro/global batch、pipeline schedule、通信重叠、activation recompute、FP8、MoE 通信等。目标是满足显存安全余量下最大化 tokens/s/GPU；支持纯解析 simulate，也支持小规模 benchmark 后投影到集群规模。 | 与“批处理和流水线配置联合优化”高度相关，可借其 **合法性检查与搜索器分离**、逐步提高 evaluator 成本、保存每次 trial 等设计。它主要针对 Primus/Megatron/TorchTitan 的预训练配置，不会重写任意训练循环或研究工作流；simulate 是分析估计，文档明确提示 simulator-reality gap 和显存建模盲点。 |
| [PyTorch Profiler](https://docs.pytorch.org/docs/stable/profiler) + [Holistic Trace Analysis (HTA)](https://docs.pytorch.org/tutorials/beginner/hta_intro_tutorial.html) | PyTorch Profiler 采集 CPU/CUDA 活动、算子输入形状、调用栈和 trace。HTA 分解各 rank 的计算、通信、内存和空闲，分析 host wait、kernel launch wait、跨 rank 耗时差异及计算/通信重叠；HTA 文档指出 host wait 可引导检查慢 CPU op、增大 batch 或 fusion，短 kernel launch 空泡可引导 CUDA Graph。 | 适合作为可解释的测量底座，能区分“GPU 算力不足”和“供给/调度断流”。它是分析库而非 agent；若 trace 只覆盖不具代表性的片段、rank 或未经过 warmup，结论可能误导。HTA 的部分等待分类用启发式，`other wait` 仍可能无法归因。 |
| [AMD TraceLens Agent](https://github.com/AMD-AGI/TraceLens/tree/main/TraceLens/Agent/Analysis) | 对 PyTorch Profiler trace 做 standalone roofline 分析或双 trace 对比，生成带证据、理由、建议的优先级报告；分类覆盖计算 kernel、kernel fusion 和 system-level（idle、memcpy、compute/comm overlap）问题。报告还设计为可被优化循环读取。 | 它是目前找到的较完整 trace-to-recommendation agent，可借鉴机器可读证据和优化优先级。仍要求用户先采集 trace、提供硬件 roofline 基线；system-level 和融合建议标为 experimental，主要输出报告，不自动提交通用代码变更。跨框架 trace 比较也可能有误导。 |
| [NVIDIA Nsight AI](https://developer.nvidia.com/nsight-ai)（CUDA MCP、Nsight Copilot Blueprint、Nsight Compute 集成） | CUDA MCP 提供 NVIDIA 一手 CUDA 文档与代码示例；Blueprint 是可自托管 backend；Nsight Compute 内的 Copilot 对 CUDA kernel 性能分析给交互式建议，例如非合并访存。 | 适合作为 CUDA/kernel 专家知识和 Nsight Compute 信号入口。现有官方产品说明没有把它描述成训练时间线或数据流水线优化器：CUDA MCP 是知识检索接口，Compute 集成关注 kernel 指标。不要把“Nsight AI”泛化成自动分析端到端训练 trace 的 agent。 |
| [PerfAdvisor](https://github.com/leonhostetler/PerfAdvisor) | 社区 agent，读 NVIDIA Nsight Systems SQLite 或 AMD rocpd profile，生成按瓶颈分类、附证据和修复建议的假设；支持多 rank imbalance 和前后 profile 对比。 | 能参考“结构化 profile → 排序假设 → profile diff”的闭环接口，也能补充 PyTorch trace 之外的系统时间线视角。仓库作者明确警告 SQL 查询、单位换算和聚合未经穷尽验证；应视为探索工具，结果需回到原始 profile 核对，不能当作可信自动判定器。 |
| [Ray Tune](https://docs.ray.io/en/latest/tune/index.html) / [Ray Train](https://docs.ray.io/en/latest/train/train.html) | 提供分布式 trial 调度、资源声明、并发实验及训练作业编排；Tune 可用调度策略缩短超参数搜索耗时，Train 管理多 worker 训练和扩缩。 | 当优化目标是“同时跑多个独立配置/seed，让实验墙钟更短”时很有用。它解决的是 trial 间调度与训练分布式执行，不会识别单个脚本内部反复串行的小算子或把小 batch 改成打包并行，因此不能替代 infra 优化 agent。 |
| [ASAP：Agentic Solution to Auto-optimize Performance of Large-Scale LLM Training](https://openreview.net/forum?id=n0JqgyQhtR) | 研究论文提出多 agent 闭环，读取实验配置、XProf/KPI、HLO/roofline 等信息，诊断大模型训练性能并推荐 sharding / 并行策略；候选配置经真实或模拟运行再回到 agent。 | 对 agent 分工和“以实际训练指标为目标、给出带取舍解释的配置”有参考价值。论文聚焦大规模 LLM sharding 选择，依赖其特定实验记录及 TPU/XProf 风格工具链，属于研究设计，不是可直接用于任意 Research Pi 代码的包。 |
| [KernelAgent](https://github.com/meta-pytorch/KernelAgent) | 多 agent 围绕 Triton kernel 生成、正确性检查、profile、瓶颈分析和 benchmark 做硬件反馈优化；PyTorch 团队报告其在指定 KernelBench 任务上的结果。 | 可作 kernel 层专项子流程，尤其当 trace 已证明少数 kernel 占主耗时后。它解决单 kernel 性能，不负责 DataLoader、Python 调度、多进程打包、batch 构造、通信/计算编排或实验工作流。其基准成绩不能外推成端到端训练加速。 |
| [ProfilingAgent / ProfilingBench](https://openreview.net/pdf/12d63efaa7e998eb631d660ba159471874323ce6.pdf) | 论文预印本提出基于性能反馈的工具调用 agent 和 104 项 GPU 优化任务 benchmark；覆盖轻量 serving 配置调整到真实推理 pipeline 重构。 | 研究问题和评测设计很接近“是否能把 profile 反馈转成应用层变更”，值得关注其 benchmark 分类。当前来源是投稿/预印本论文，不能据此断言已有稳定可安装工具或训练优化能力。 |

## 对照：成熟底层工具能告诉我们什么

HTA 明确区分 GPU host wait 和连续 kernel launch 间隙；这能支撑两种不同干预：数据/CPU供给侧并行化，或减少小 kernel 调度开销。分布式训练再用 rank 时间差和计算/通信 overlap 判断是否是 straggler 或未覆盖的通信。单看 `nvidia-smi` 利用率无法完成这类归因。

Nsight AI 的产品能力需要按模块理解：文档/代码 MCP、可自托管 CUDA assistant、Nsight Compute kernel 助手不是一个覆盖所有训练层次的 profiling agent。反过来，kernel agent 也不应拿来优化 Python/数据处理/小 batch 反复提交的问题。

## 证据边界

上述仓库和论文公布的 benchmark 数字只适用于所列任务、硬件、软件版本和测量方式；它们不是 Research Pi 工作负载的预期加速比。Primus 的 `simulate`、TraceLens 的 impact score、PerfAdvisor 的 LLM 假设都属于排序/估计线索。对具体任务，端到端训练或实验墙钟、目标指标有效性、等价工作量和收敛/输出一致性仍需实测确认。
