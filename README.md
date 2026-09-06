# dsh-token-optimizer

DeepSeek Harness 分层 Token 优化管道(v2)。

> 基于真实 DSH 插件 API 实现,与社区方案文档(v1.0.0)中的虚构事件
> (`message:before` / `context:building` / `tool:after` / `session:end`)无关。
> 真实钩子:`agent/pre-step`(改写收件箱消息批次)、`tools/execute`(around-dispatch)、
> `tools/post-execute`(工具结果出生点替换)、`agent/status` / `agent/created` /
> `agent/disposed` / `session/event` / `session/disposed`。

## 原则

1. **不重复造轮子**:DSH 已内置 token-meter(计量)、compaction-basic(LLM 摘要压缩,可逆)、
   tool-result-pruner(8192 字符,仅压缩触发时)、spill-local(>50k 字节输出转磁盘可检索)、
   llm-retry、repeat-tool-reminder——这些一律不实现。
2. **只做真实增量**:长文本→图片摘要、输出阶梯分流、结果缓存、文件 diff、工具裁剪、
   MCP 懒加载、压缩调度、会话统计(含缓存命中率)。
3. **可逆**:压缩/采样/摘要只在进入模型的投影层生效,原始内容落盘可再读;
   compactionDriver 驱动的压缩由核心执行,原文留在 append-only 会话日志,可回放。

## 模块

| 模块 | 钩子 | 说明 |
| :--- | :--- | :--- |
| text2img | `agent/pre-step` | 超长自然语言文本(>5000 字符)渲染成图 → vision API 读图 → 摘要替换进上下文。实测省 ~72%。JSON/代码跳过。超长文本自动分页,多页一次送审 |
| outputLadder | `tools/post-execute` | 工具输出出生点**单次遍历分流**:错误结果→300 字符摘要;JSON 数组/CSV(≥10k 字符)→结构感知压缩(schema+采样);shell 类输出(≥8k 字符)→头尾+等距采样(带行号);≥50k 字节交给核心 spill;read 类豁免。原文落盘 `~/.dsh/token-optimizer/originals/`。合并了 v1 的 compress/sample/pruning |
| cache | `tools/execute` | 相同工具调用(名称+参数指纹)TTL 内短路复用;仅缓存白名单只读工具(默认 glob/grep) |
| monitor | `session/event` + `session/disposed` | 会话结束输出节省统计 + **真实模型 usage 聚合与缓存命中率**(cacheReadTokens / (input + cacheRead)) |
| fileDiff | `tools/post-execute` | 重复读文件:同路径未变化→折叠为"未变化"标记;有变化→只发变更区间 diff(跨调用记哈希) |
| toolTrim | `agent/created` | 工具可见性管理:静态 `tools.restrict({allow,deny})` 裁剪 + **mcpLazy**——`mcp__*` 工具默认全拦截,注册 `mcp_load_tools` 元工具按名放行(会话内保持);无 MCP 部署自动 no-op |
| compactionDriver | `agent/status` | 压缩调度器:agent idle 时按自定义压力比(默认 45%)驱动核心 `ctx.compaction.compactNow`。核心自带的 0.8 阈值对 1M 窗口模型几乎永不触发,本模块让压缩真正发生。原文可回放,可逆。**⚠ web 部署注意**:dsh-web-app 的 bundle patch 禁用了 `compaction-basic` 行(连同 /compact 命令),web profile 需在 cordis.patch.yml 补两行重新启用,否则本模块静默不生效(启动日志会提示) |

## 配置

挂载后可在 profile 的 `cordis.patch.yml` 中覆盖配置(示例):

```yaml
- id: token-optimizer
  name: 'dsh-token-optimizer'
  config:
    text2img:
      enabled: true
      threshold: 5000
      visionModel: 'deepseek-v4-flash-vision-exp'
      baseUrl: 'https://api.deepseek.com/v1'
      prompt: '请阅读图片中的文字内容,输出一份简洁准确的中文摘要,保留关键数字、专有名词和结构要点。'
      maxSummaryChars: 2000
      saveOriginal: true
    outputLadder:
      enabled: true
      structureThreshold: 10000  # JSON 数组/CSV 结构压缩阈值(字符)
      compressionRate: 0.5       # JSON 采样率
      preserveHeadTail: 1000
      shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd']
      shellThreshold: 8000       # shell 输出采样阈值(核心 spill 管 >50000 字节)
      headLines: 10
      tailLines: 10
      sampleInterval: 20
      errorSummaryChars: 300     # 错误结果摘要上限
      spillBytes: 50000          # 与核心 spill-policy maxInlineBytes 对齐,超限放行
      readTools: ['read', 'read_image']
      saveOriginal: true
    cache:
      enabled: true
      ttl: 3600
      allowlist: []          # 默认:['glob','grep']
    monitor:
      enabled: true
      showInChat: true
    fileDiff:
      enabled: true
      tools: ['read']      # 只追踪这些工具的文件读取
      minSize: 2048        # 小于此字符数的文件不追踪
      maxFileBytes: 200000 # 超过此字节数放弃(太大不值得 diff)
      contextLines: 3      # diff 变更区段前后保留的上下文行数
      collapseUnchanged: true
    toolTrim:
      enabled: false       # 默认关闭;启用后经 agent/created 对每个 agent 作用域生效
      allow: []            # 仅保留的工具名;与 deny 至少一个非空;未知工具名会在启动日志告警(附已知清单)
      deny: []
      mcpLazy: true        # MCP 工具懒加载(检测不到 mcp__* 工具时静默 no-op)
      mcpPrefix: 'mcp__'
      mcpLoadToolName: 'mcp_load_tools'
    compactionDriver:
      enabled: true
      pressureRatio: 0.45           # totalTokens / contextWindow 超过该比才触发
      minTurns: 6                   # 会话最少轮数(挡掉短命会话/子代理)
      minTokens: 100000             # 上下文最少 token
      maxCompactionsPerSession: 3   # 每会话压缩次数上限
      contextWindow: 1000000        # fallback;优先读会话日志 request/context 事件
      timeoutMs: 120000
```

### web 部署必读:重新启用核心压缩后端

`dsh-web-app` 的 bundle patch 把 `compaction-basic` 与 `command-compact` 两行禁用了
(注释称"移到 preset 平面",但当前版本无人重挂),web 部署因此**没有 compaction 服务**,
compactionDriver 会拿不到服务而静默不生效。在 profile 的 `cordis.patch.yml` 顶层补:

```yaml
- id: compaction-basic
  disabled: false
- id: command-compact
  disabled: false
```

(`/compact` 手动压缩命令也随之一并解锁。)

> v1 的 `compress` / `sample` / `pruning` / `dedup` 节已退役(合并进 outputLadder 或删除),
> 旧配置节会被静默忽略并在日志提示,不会导致插件加载失败。

## 依赖

- **text2img 渲染**:Windows 需 PowerShell + .NET System.Drawing(脚本 `scripts/render-text.ps1`,
  免第三方依赖);非 Windows 平台渲染降级为仅落盘原文。
- **text2img 摘要**:需要 `DEEPSEEK_API_KEY` 环境变量(DSH 已配置)。
- 视觉走 DeepSeek 原生 `deepseek-v4-flash-vision-exp`(384 token/张封顶,约 0.001 元/张),
  不依赖 modlens/Gemini/Claude。
- **mcpLazy**:需要 profile 挂载 `@deepseek-ai/dsh-mcp-client` 并配置至少一个 MCP 服务器
  (工具名形如 `mcp__<server>__<tool>`);无 MCP 服务器时该功能自动 no-op。

## 安装

```bash
dsh plugin --profile web add ./dsh-token-optimizer
```

卸载:

```bash
dsh plugin --profile web remove dsh-token-optimizer
```

卸载后原始数据目录(`~/.dsh/token-optimizer/`)由用户决定保留或删除。

## 开发

```bash
node --check src/index.js src/config.js src/stats.js src/modules/*.js
node test/smoke.mjs                    # 单进程全量检查(无需 API),npm test 同
node --test test/modules.test.js       # node:test 单元测试(非沙箱环境)
node test/text2img-e2e.mjs             # text2img 真实端到端(需 API key + Windows 渲染)
```

> 注:沙箱环境里 node spawn 子进程会被拦,text2img 的真实渲染链路需在 DSH 进程
> 或普通终端中验证;单测用注入的 mock 渲染器覆盖完整流程。

## 路线图(后续期)

- 自然语言配置工具(`token-optimizer-config` 工具,让模型改配置)
- toolTrim 摘要化(工具描述一句话模式)——当前工具 schema 已较紧凑,实测收益 <1%,暂缓
- 长文本→图片的跨平台渲染(fallback)
- 与 dsh-behavior-enhancer 协同(内容压缩 × 行为管理,可独立安装)
