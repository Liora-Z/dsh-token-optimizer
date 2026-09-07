# dsh-token-optimizer

> DeepSeek Harness 分层 Token 优化管道。**在 DSH 已内置能力之外做真实增量**：
> 把进入模型的文本压缩/裁剪/采样，降低 token 开销，不牺牲模型能力。

基于真实 DSH 插件 API（`agent/pre-step`、`tools/execute`、`tools/post-execute`、`agent/status` 等）实现，
与社区方案文档中虚构的事件(如 `message:before` / `context:building`)无关。

## 它做什么（30 秒版）

| 模块 | 钩子 | 作用 |
| :--- | :--- | :--- |
| text2img | `agent/pre-step` | 超长自然语言文本（>5000 字符）→ 渲染成图 → vision 读图 → 摘要替换进上下文。单次样本曾省 ~72%；真正价值是**长会话越省**（后续轮次不再携带原文）。JSON/代码自动跳过 |
| outputLadder | `tools/post-execute` | 工具输出出生点**单次遍历分流**：错误结果→300 字符摘要；JSON 数组/CSV（≥10k 字符）→结构感知压缩；shell 输出（≥8k 字符）→头尾+等距采样；≥50k 字节交核心 spill；read 类豁免。原文落盘可逆 |
| fileDiff | `tools/post-execute` | 重复读文件：未变→折叠标记；有变→只发变更区段 diff |
| toolTrim | `agent/created` | 工具可见性管理：静态裁剪 + **MCP 懒加载**——不用的 `mcp__*` 工具 schema **不进请求**（实测省 ~9.4k token/请求） |
| compactionDriver | `agent/status` | agent idle 时按自定义压力比（默认 45%）驱动核心 `compactNow`，让长会话压缩真正发生（核心 0.8 阈值对 1M 窗口几乎永不触发） |
| monitor | `session/disposed` | 会话结束输出节省统计 + **真实 usage 聚合与缓存命中率**(长会话常态 97%–99.3%) |
## 与 DSH 核心的边界

DSH 已内置 `token-meter`、`compaction-basic`、`tool-result-pruner`、`spill`、`llm-retry`、`repeat-tool-reminder`——
**本插件一律不重复实现**，只做上面这些内置之外的增量。

## 安装

```bash
dsh plugin --profile web add ./dsh-token-optimizer
```

卸载：

```bash
dsh plugin --profile web remove dsh-token-optimizer
```

## 配置

挂载后在 profile 的 `cordis.patch.yml` 中覆盖（示例，均为默认值）：

```yaml
- id: token-optimizer
  name: 'dsh-token-optimizer'
  config:
    text2img:
      enabled: true
      threshold: 5000
      pageFontSize: 24
      pageMaxHeight: 3000
      visionModel: 'deepseek-v4-flash-vision-exp'
      baseUrl: 'https://api.deepseek.com/v1'
      maxSummaryChars: 2000
      saveOriginal: true
      askOnSkip: true
    outputLadder:
      enabled: true
      structureThreshold: 10000
      compressionRate: 0.5
      preserveHeadTail: 1000
      shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd']
      shellThreshold: 8000
      headLines: 10
      tailLines: 10
      sampleInterval: 20
      errorSummaryChars: 300
      spillBytes: 50000
      readTools: ['read', 'read_image']
      saveOriginal: true
    cache:
      enabled: true
      ttl: 3600
    fileDiff:
      enabled: true
      tools: ['read']
      minSize: 2048
      maxFileBytes: 200000
      contextLines: 3
      collapseUnchanged: true
    toolTrim:
      enabled: false          # 默认关闭；启用后对每个 agent 作用域生效
      allow: []
      deny: []
      mcpLazy: true
      mcpPrefix: 'mcp__'
      mcpLoadToolName: 'mcp_load_tools'
    compactionDriver:
      enabled: true
      pressureRatio: 0.45     # totalTokens / contextWindow 超过该比才触发
      minTurns: 6
      minTokens: 100000
      maxCompactionsPerSession: 3
      contextWindow: 1000000
      timeoutMs: 120000
```

> v1 的 `compress` / `sample` / `pruning` / `dedup` 节已退役（合并进 outputLadder），旧配置节会被静默忽略并在日志提示，不会导致加载失败。

### web 部署必读：重新启用核心压缩后端

`dsh-web-app` 的 bundle patch 默认**禁用**了 `compaction-basic` 与 `command-compact`（配合 /compact 命令），
web 部署因此**没有 compaction 服务**，`compactionDriver` 会静默不生效。在 profile 的 `cordis.patch.yml` 顶层补：

```yaml
- id: compaction-basic
  disabled: false
- id: command-compact
  disabled: false
```

## 依赖

- **text2img 渲染**：Windows 需 PowerShell + .NET System.Drawing（`scripts/render-text.ps1`，免第三方依赖）；非 Windows 渲染降级为仅落盘原文。
- **text2img 摘要**：需 `DEEPSEEK_API_KEY` 环境变量（DSH 已配置）。
- **mcpLazy**：需 profile 挂载 `@deepseek-ai/dsh-mcp-client` 并配置至少一个 MCP 服务器；无 MCP 时自动 no-op。

## 权限与边界（上架声明）

本插件是**高权限**插件：为实现压缩/转图/调度功能，运行时需要访问文件、网络、命令与凭据。以下为完整边界声明（与 DSH Store 审查口径一致）：

| 类别 | 实际行为 | 边界 |
| :--- | :--- | :--- |
| 文件 files | 写 `~/.dsh/token-optimizer/` 下的落盘原文（text2img-originals / originals / filediff-originals）、系统临时目录的渲染 PNG；设 `DSH_TOKEN_OPTIMIZER_DEBUG=1` 时写调试日志 | 只写插件自有状态目录与临时产物，**不写 Profile 配置、不改 DSH 核心/官方包**；日志默认关闭 |
| 网络 network | text2img 摘要调用 `baseUrl`（默认 `https://api.deepseek.com/v1`）的 `/chat/completions` | 只向该端点发送需摘要的文本与渲染图；请求失败即降级跳过转图，不阻断会话 |
| 命令 commands | Windows 上用 PowerShell + .NET System.Drawing 渲染文本图片（`scripts/render-text.ps1`） | 只执行插件自带渲染脚本，参数固定；非 Windows 自动降级为仅落盘，不执行任何命令 |
| 凭据 credentials | 经 DSH 凭据服务 `ctx.credentials.resolve` 读取；不可用时回退 `process.env.DEEPSEEK_API_KEY` | 仅用于 text2img 的 vision 调用，写入请求头后不落盘、不写日志、不外传 |

- **运行时依赖**：零 npm 依赖。text2img 摘要依赖外部服务 DeepSeek API（key 由 DSH 凭据/环境变量提供）；Windows 渲染依赖 PowerShell + .NET System.Drawing（系统自带）。
- **失败边界**：所有模块 fail-open——任一步出错只降级跳过（保留原文），不影响 DSH 核心流程；模块间无共享可变状态，卸载时统一清理钩子。
- **已知风险**：text2img 摘要可能不准确（摘要自带警告标记，原文落盘可查）；outputLadder/fileDiff 压缩丢细节（原文落盘可回放）；compactionDriver 触发压缩后旧历史按 DSH 核心语义进入可回放区；toolTrim 的 `allow` 为排他白名单，误配会让工具对模型不可见（默认关闭）。
- **兼容范围**：完整开发与验证基于 DSH `0.1.1-rc.2`（Node ≥ 18）；`0.1.2+` 与 `0.1.3+` 尚未验证，在 `package.json` 的 `dsh.compatibility.dshReleases` 中标为 `unknown`。


## 开发

```bash
node test/smoke.mjs          # 单进程全量自检（无需 API），npm test 同
node --test test/modules.test.js
node test/text2img-e2e.mjs   # 真实端到端（需 API key + Windows 渲染）
```

## 路线图

- 自然语言配置工具（让模型改配置）
- 长文本→图片的跨平台渲染 fallback
- 与 [dsh-behavior-enhancer](https://github.com/Liora-Z/dsh-behavior-enhancer) 协同（内容压缩 × 行为管理，可独立安装）

## 许可 / License

[MIT](LICENSE) © 2026 Liora
