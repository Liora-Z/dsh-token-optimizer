# dsh-token-optimizer & dsh-behavior-enhancer — 技术决策记录

> **Design Decisions & Technical Report**
> 本记录以"问题 → 方案 → 为什么这么设计 → 实测结果"的方式，
> 梳理两个插件在真实 DSH（DeepSeek Harness）插件 API 上做对的几个关键判断。
> 所有数据均为真实会话实测，未虚构。

---

## 0. 项目背景

DSH（DeepSeek Harness）是一个 **Cordis 插件宿主**，插件通过 `ctx.on(event, handler)` 挂在真实事件上。
两个插件分工：

| 插件 | 管什么 | 一句话 |
| :--- | :--- | :--- |
| **dsh-token-optimizer** | 进入模型的**内容** | 压缩/裁剪/采样/摘要，降低 token 开销 |
| **dsh-behavior-enhancer** | 模型**怎么调用工具** | 行为纪律/失败收敛/并行度恢复，提升稳定性 |

两者互相独立、可单独安装。本文聚焦四个有工程深度的技术决策。

---

## 1. 「只做核心之外的增量」——边界优先的架构判断

### 问题
DSH 核心**已经内置**了 `token-meter`、`compaction-basic`、`tool-result-pruner`、`spill`、`llm-retry`。
如果插件把这些**再实现一遍**，是重复造轮子，还会和核心打架，甚至破坏稳定性。

### 方案
**明确拒绝重复实现核心已有能力**，只做它们**覆盖不到的区间**。

| 核心内置 | 本插件对应补充 | 补充的缝隙 |
| :--- | :--- | :--- |
| spill（>50k 字节） | outputLadder | **8k–50k 字符的"裸奔区"**（spill 管不到、pruner 只有压缩触发才动） |
| tool-result-pruner（8192 字符） | outputLadder 采样 | shell 输出头尾+等距采样，带行号 |
| compact basic（0.8 阈值） | compactionDriver | **0.8 阈值对 1M 窗口模型几乎永不触发**；本模块拉低到 0.45 让压缩真的发生 |
| （MCP 工具 schema 全量注入） | toolTrim / mcpLazy | **不用的 MCP 工具 schema 不进请求** |

### 为什么这么设计
核心源码核实出的**边界**是设计前提——把"核心已解决的"和"核心忽略的"划清，插件才是**真增量**，而不是重复或对抗。

### 实测结果
- `outputLadder`：**单次实测**（9-1 会话，8 个 9k–50k 字符裸奔输出被采样）省约 **10% 总输入**；常态比例待进一步统计。
- `toolTrim + mcpLazy`：24 个 modlens MCP 工具 schema（≈ **9,362 token**）被拦在请求外，每请求省固定开销 9k。
- `compactionDriver`：让上下文压缩**从"理论"变"实际会跑"**（核心 0.8 阈值在 1M 窗口下实测 49 万 token 也未触发）。

---

## 2. restrict 死循环事故：一次 OOM 级事故催生的三重防护

### 问题（真实事故）
`tools.restrict()` 会改变工具可见性并**触发 `tools/change` 事件**。
插件若监听 `tools/change` 做重挂 → 重挂又调用 `restrict` → 又触发 `tools/change` → …
**形成死循环，130 万次把 DSH harness 直接 OOM 崩掉（exit 134）。**

### 方案（三重防护）
1. **`filterKey` 幂等**：`JSON.stringify(filter)` 作为键，filter 没变就不重挂。restrict 只在**成功**后才记录 filterKey，失败不记录（允许下次用同 filter 重试）。
2. **工具集变化检测**：`onToolsChange` 重新发现 MCP 工具名，**先比对**是否真的变了；无真实变化直接返回（防"change→重挂→change"循环）。
3. **"already registered"视为成功**：挂载时若报同名已注册（重复事件/作用域残留），视为已注册，不再重试。

### 为什么这么设计
这是**幂等性 + 变化检测**的经典组合：**让"响应事件的动作"本身不再触发"要响应的事件"**。
严格遵循契约："先挂新、后撤旧"（fail-closed），挂新失败则旧 gate 原样保留，**绝不提前放行**。

### 实测结果
- 回归测试：连续 20 次 `tools/change` 事件，无真实变化时**不再重挂**（restrict 次数不变），死循环被切断。
- 这个 bug 的根因是「**副作用触发自身被监听的事件**」，是一道很好的工程题。

---

## 3. 两档失败识别：理解工具层 vs 命令层的边界

### 问题
DSH 的 `pwsh` 工具**只有基础设施错误**（spawn 失败/中止）才标 `isError: true`。
**命令级失败**（非零退出码 / stderr 报错）作为**普通成功结果**返回——
实测：`$ErrorActionPreference='Stop'; Get-Item missing` 的结果是 `isError: false`，内容带 `[stderr] ... [exit code: 1]`。

如果并行收敛只判断 `result.isError`，**命令级失败会被当成成功**，串行化永远不触发——这是测试中最容易踩的坑。

### 方案（`detectFailure`）
新增**命令级失败识别**（`stderrAsFailure`，默认开）：
1. **非零退出码**（最强信号）：正则 `[exit code: 1-9]`。
2. **stderr 典型错误签名**：`error|failed|exception|cannot|not found|no such file|does not exist|access denied|找不到|不存在|拒绝访问|无法`，并**避开 warning 类噪音**。

### 为什么这么设计
这是对**工具边界语义的逆向理解**——不只看"工具说没失败"，还要看"命令实际失败没失败"。
两档（`isError` + 命令级签名）互为补充，命令级签名用正则而非结构化 API，因为 DSH 把命令结果平铺进 content 文本。

### 实测结果
- 用 `Get-Item missing` 触发，`detectFailure` 正确识别为失败 → `serialize()` 触发，并行池上限压到 1。
- **诚实边界**：正则偏英文 Windows 报错路径；中文 or 无 exit code 的服务端错误可能漏检——这是后续需要补强的点。

---

## 4. 跨进程状态持久化：修复"陈旧并行度永不还原"

### 问题
`parallelConvergence` 在**工具失败时**把 `maxParallelToolCalls` 压到 1，**连续成功恢复**。
但若"串行化之后、恢复之前"**进程被杀 / 会话未结束**，新实例启动时 `serialized = false`，
**那份陈旧但真实的 `maxParallelToolCalls = 1` 永远不被还原**——用户的并行度被永久卡在 1。

### 方案（`state.json` 跨 boot 持久化）
1. **串行化时落盘**：`serialize()` 写入 `~/.dsh/behavior-enhancer/state.json`，记录 `{ serialized: true, originalParallel }`。
2. **启动接管还原**：`ctx.inject(['settings'])` 回调里，若读到 `stale.serialized && 当前值 === 1`，则还原到 `originalParallel`，并打印接管日志。
3. **还原时清除**：`restore()` 调用 `clearState()` 删除文件。

### 为什么这么设计
这是**分布式/长期运行进程的状态持久化**经典问题：**"进程没了，但它在内存里擅自改过的共享状态还在"**。
把"中断后的状态留痕"落盘，重启时主动接管，保证**篡改的状态最终一定被还原**，而不是永久残留。

### 实测结果
- 构造 `serialized: true` 状态文件 → 插件启动检测并还原 → 文件被清除。
- **交叉验证**：测试会话里 `state.json` 从 `{"serialized":true,...}` → 成功 3 次后被 `clearState()` 删除，证明 `restore()` 真实执行。

---

## 5. 让「省钱 × 稳定性」成对展示

- **dsh-token-optimizer**：管内容，直接省 token（长文转图常态省 60%–70%，极端样本可到 90%+；输出压缩、MCP 懒加载省 9k/请求、缓存命中率长会话常态 97%–99.3%，单次最优样本 99.75%）。

> 这正是本项目的差异化：**不在"省钱"或"稳定"单点上挤，而是作为一对互补的工程方案**。

---

## 附：实测数据汇总

| 模块 | 实测 |
| :--- | :--- |
| text2img | 常态省 **60%–70%**（极端样本达 90%+）；忠实度小页分页连续 4 次命中 |
| outputLadder | 单次实测约省 10%（9-1 会话），常态待统计 |
| mcpLazy | 24 个 MCP 工具 schema ≈ 9,362 token 拦在请求外 |
| 缓存命中率 | 长会话常态 **97%–99.3%**（单次最优样本 99.75%）；小会话 ~68% |
| parallelConvergence | 失败→池压 1；连续 3 次成功→恢复原值；跨进程持久化还原 |
---
*贡献者：Liora2050348900*
