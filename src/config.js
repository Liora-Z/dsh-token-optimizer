// 配置默认值与校验。与方案文档 4.1 的 YAML 结构对齐,但只保留真实落地的键。

export const DEFAULT_CONFIG = {
  // ===== 第1层:输入预处理 =====
  // 长文本→图片:超长自然语言文本渲染成图,经 vision API 读图得摘要后以文字替换进上下文。
  // 可靠性修复(2026-09-03 对照实验):flash-vision-exp 读"高密度大页"会整篇脑补
  // (小红书/浪潮AI服务器/法硕考研三次事故),根因是单页信息密度过高。
  // 实验结论:字号 24 + 页高 3000(约每页 ~1k 字,6.4k 字 → 6 页)三测三中,
  // 忠实度稳定(关键词 8/8、7/8);字号 16 + 页高 7800(2 页)持续脑补。
  // 因此默认小页分页(pageFontSize 24 / pageMaxHeight 3000);摘要仍标注"可能不准确",
  // 细节引用前必须核对落盘原文。
  text2img: {
    enabled: true,
    threshold: 1000,           // 字符数阈值,达到即弹窗询问(不限内容类型)
    // v2.1 询问策略:达阈值一律询问,内容类型决定推荐项(首位)与超时默认值——
    // 自然语言→转图摘要;结构性强→直接阅读原文。堵上 v2.0"纯散文自动转图
    // 导致读不到原文细节"的坑(实际事故:让 DSH 看方案细节结果只读到摘要)。
    askOnSkip: true,           // false = 关闭询问,回退 v2.0 自动行为(自然语言自动转图/结构性强跳过)
    askTimeoutMs: 120000,      // 询问超时(毫秒),超时按内容类型默认执行(2 分钟)
    maxAsksPerSession: 0,      // 每会话弹窗次数上限(0=不限);超过后按内容类型默认静默执行。
                               // 每个新长文本都会弹窗的降噪阀(实测:连测 4 段文本 = 4 次弹窗,嫌多可设 3~5)
    summaryCache: true,        // 内容 hash → 摘要磁盘缓存,跨会话命中 0 API 调用
    dynamicResolution: true,   // 按字数分档渲染尺寸(见 resolutionTiers);false 用 renderWidth+分页
    renderWidth: 1200,         // dynamicResolution=false 时的固定渲染宽度
    // 动态分辨率分档(2026-09-09 实测校准):
    // 实测 Microsoft YaHei 在 GDI+ 下行高 ≈1.9×字号(24px→43px,36px→70px),
    // 中英混排换行还偏碎,导致 640×360/1280×720 原分档只有 ~107/~417 字/页,页数翻倍。
    // 按"改画布不动渲染"原则放大尺寸(字形/行距/换行全部不变,已验证的保真度继续有效):
    // 800×450 ≈ 240 字/页、1440×810 ≈ 920 字/页(回到 v2.0 三测三中的 ~1千字/页 安全水平)、
    // 1920×1080@36 号 ≈ 420 字/页;幻觉事故密度 ~3.2千字/页,各档均有 3.5 倍以上余量。
    resolutionTiers: [
      { maxChars: 2000, width: 800, height: 450, fontSize: 24 },
      { maxChars: 6000, width: 1440, height: 810, fontSize: 24 },
      { maxChars: Infinity, width: 1920, height: 1080, fontSize: 36 },
    ],
    pageFontSize: 24,          // 渲染字号(dynamicResolution=false 时用)
    pageMaxHeight: 3000,       // 单页最大高度(dynamicResolution=false 时用)
    visionModel: 'deepseek-v4-flash-vision-exp',
    baseUrl: 'https://api.deepseek.com/v1',  // OpenAI 兼容端点
    prompt: '请阅读全部图片页中的文字,输出一份简洁准确的中文摘要,保留关键数字、专有名词和结构要点。要求:①重点概括正文的实质内容,忽略标题、作者、链接、来源、版权声明等元信息(这类信息最多一句话带过,禁止当成核心内容);②内容跨多页时逐页阅读、完整覆盖,不得只概括开头几页;③只概括原文中出现的内容,不得添加原文没有的信息;无法识别或模糊的部分标注为[无法识别],不要猜测。',
    pagesPerBatch: 4,          // 分批摘要:每批最多送这么多页给 vision。
                               // 实测 flash-vision 一次读 8+ 页会只概括开头几页并脑补"原文在此处结束",
                               // 正文后续全丢(知乎长文事故第二形态)。分批强制全覆盖,再纯文本合并。
                               // 成本:每批 1 次 Flash vision 调用 + 1 次纯文本合并调用。
    maxSummaryChars: 2000,     // 摘要上限(替换进上下文的文字长度)
    maxSummaryRatio: 0.4,      // 摘要上限随输入缩放:实际上限 = min(maxSummaryChars, 输入字数×该比)。
                               // 保证替换后一定比原文短——否则 v2.1 短文本会因摘要超长而保留原文、vision 白烧。
    reasoningBudget: 16384,    // vision 推理模型的思考 token 预留(max_tokens = 摘要上限 + 该预算;
                               // 预算不足时思考吃光额度返回空摘要——真实事故:4096 不够,51 秒思考后 content 为空)
    saveOriginal: true,        // 原始文本落盘(可逆)
  },
  // ===== v2 输出阶梯:post-execute 单次遍历分流(合并 v1 compress/sample/pruning 截断意图) =====
  outputLadder: {
    enabled: true,
    structureThreshold: 10000, // JSON 数组/CSV 结构压缩阈值(字符)
    compressionRate: 0.5,      // JSON 采样率
    preserveHeadTail: 1000,    // JSON/CSV 头尾保留量
    shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd'], // shell 类工具(采样)
    shellThreshold: 8000,      // shell 输出采样阈值(字符;核心 spill 管 >50000 字节)
    headLines: 10,             // 采样头部保留行数
    tailLines: 10,             // 采样尾部保留行数
    sampleInterval: 20,        // 中间等距采样间隔
    errorSummaryChars: 300,    // 错误结果摘要上限
    spillBytes: 50000,         // 与核心 spill-policy maxInlineBytes 对齐,超限放行
    readTools: ['read', 'read_image'], // 豁免工具:首次读完整保留
    saveOriginal: true,        // 原文落盘(可逆)
  },
  // ===== v2 压缩调度器:idle 时按自定义压力比驱动核心 compaction(核心 0.8 阈值对 1M 窗口永远不触发) =====
  compactionDriver: {
    enabled: true,
    pressureRatio: 0.45,           // totalTokens / contextWindow 超过该比才触发
    minTurns: 6,                   // 会话最少轮数(挡掉短命会话/子代理)
    minTokens: 100000,             // 上下文最少 token(太小不值得压)
    maxCompactionsPerSession: 3,   // 每会话压缩次数上限(防失控)
    contextWindow: 1000000,        // fallback 窗口;优先读 request/context 事件
    timeoutMs: 120000,             // 单次压缩超时
  },
  // 结果缓存
  cache: {
    enabled: true,
    ttl: 3600,
  },
  // ===== 监控 =====
  monitor: {
    enabled: true,
    showInChat: true,          // 会话结束时输出节省统计
  },
  // ===== 新增:重复读文件 → 增量 diff =====
  fileDiff: {
    enabled: true,
    tools: ['read'],
    minSize: 2048,
    maxFileBytes: 200000,
    contextLines: 3,
    collapseUnchanged: true,
  },
  // ===== 工具 schema 按会话裁剪(默认关闭;启用后经 agent/created 对每个 agent 作用域生效) =====
  // v2 新增 mcpLazy:mcp__* 工具默认全部拦截,经 mcp_load_tools 元工具按名放行(无 MCP 部署自动 no-op)
  toolTrim: {
    enabled: false,
    allow: [],
    deny: [],
    mcpLazy: true,              // MCP 工具懒加载(检测不到 mcp__* 工具时静默 no-op)
    mcpPrefix: 'mcp__',         // MCP 工具名前缀(dsh-mcp-client 的公开名格式)
    mcpLoadToolName: 'mcp_load_tools', // 放行元工具名
  },
  // ===== memory-bridge 联动占位(dsh-memory-bridge 阶段 3b 完成后开开关即可) =====
  // 现阶段 enabled: false,不注册任何钩子,仅让配置节合法存在。
  memory_bridge: {
    enabled: false,
    sync_dir: '~/.dsh-memory',
    compress_on_sync: true,
    compression_strategy: 'time_decay',
    text2img_threshold: 1000,
    dynamic_resolution: true,
  },
}

const NUMERIC_KEYS = new Set([
  'threshold', 'compressionRate', 'preserveHeadTail', 'ttl',
  'maxSummaryChars', 'headLines', 'tailLines', 'sampleInterval',
  'minSize', 'maxFileBytes', 'contextLines',
  'structureThreshold', 'shellThreshold', 'errorSummaryChars', 'spillBytes',
  'pressureRatio', 'minTurns', 'minTokens', 'maxCompactionsPerSession', 'contextWindow', 'timeoutMs',
  'reasoningBudget', 'pageFontSize', 'pageMaxHeight',
  'askTimeoutMs', 'renderWidth', 'text2img_threshold', 'maxSummaryRatio', 'maxAsksPerSession', 'pagesPerBatch',
])
const STRING_KEYS = new Set(['visionModel', 'baseUrl', 'prompt', 'sync_dir', 'compression_strategy'])
const STRING_ARRAY_KEYS = new Set(['tools', 'allow', 'deny', 'shellTools', 'readTools'])

// 结构化值校验(超出数字/字符串/布尔的基础校验)
const CUSTOM_VALIDATORS = {
  resolutionTiers(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error('dsh-token-optimizer config: "resolutionTiers" must be a non-empty array of {maxChars, width, height, fontSize}')
    }
    let prev = 0
    for (const tier of value) {
      if (!tier || typeof tier !== 'object') {
        throw new Error('dsh-token-optimizer config: each resolutionTier must be an object {maxChars, width, height, fontSize}')
      }
      for (const k of ['maxChars', 'width', 'height', 'fontSize']) {
        if (!Number.isFinite(tier[k]) || tier[k] <= 0) {
          throw new Error(`dsh-token-optimizer config: resolutionTier "${k}" must be a positive number`)
        }
      }
      if (tier.maxChars <= prev) {
        throw new Error('dsh-token-optimizer config: resolutionTiers maxChars must be strictly increasing')
      }
      prev = tier.maxChars
      // DeepSeek 视觉 API 长边限制实测 ~8124,留安全余量
      if (Math.max(tier.width, tier.height) > 8000) {
        throw new Error('dsh-token-optimizer config: resolutionTier width/height must be <= 8000 (vision API long-side limit)')
      }
    }
  },
}

function assertNumber(name, value, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`dsh-token-optimizer config: ${name} (${value}) must be a number in [${min}, ${max}]`)
  }
}

function resolveSection(section, defaults) {
  const out = { ...defaults }
  if (section && typeof section === 'object') {
    for (const [key, value] of Object.entries(section)) {
      if (!(key in defaults)) {
        throw new Error(`dsh-token-optimizer config: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`)
      }
      if (NUMERIC_KEYS.has(key)) {
        if (key === 'compressionRate' || key === 'pressureRatio') assertNumber(key, value, { min: 0, max: 1 })
        else if (key === 'maxSummaryRatio') assertNumber(key, value, { min: 0.1, max: 1 })
        else assertNumber(key, value)
      } else if (STRING_ARRAY_KEYS.has(key)) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new Error(`dsh-token-optimizer config: "${key}" must be an array of strings`)
        }
      } else if (STRING_KEYS.has(key)) {
        if (typeof value !== 'string') throw new Error(`dsh-token-optimizer config: "${key}" must be a string`)
      } else if (CUSTOM_VALIDATORS[key]) {
        CUSTOM_VALIDATORS[key](value)
      } else if (typeof value !== typeof defaults[key]) {
        throw new Error(`dsh-token-optimizer config: "${key}" must be ${typeof defaults[key]}`)
      }
      out[key] = value
    }
  }
  return Object.freeze(out)
}

// v1 退役节:用户配置里遗留时静默忽略 + 提示(绝不抛错——抛错会炸整个插件树)
const LEGACY_SECTIONS = new Set(['compress', 'sample', 'pruning', 'dedup'])

export function resolveConfig(config = {}) {
  if (typeof config !== 'object' || config === null) config = {}
  for (const name of LEGACY_SECTIONS) {
    if (config[name] !== undefined) {
      console.warn(`[dsh-token-optimizer] 配置节 "${name}" 已废弃(v2 合并进 outputLadder 或退役),已忽略。请从 cordis.patch.yml 移除该节。`)
    }
  }
  return Object.freeze({
    text2img: resolveSection(config.text2img, DEFAULT_CONFIG.text2img),
    cache: resolveSection(config.cache, DEFAULT_CONFIG.cache),
    monitor: resolveSection(config.monitor, DEFAULT_CONFIG.monitor),
    fileDiff: resolveSection(config.fileDiff, DEFAULT_CONFIG.fileDiff),
    toolTrim: resolveSection(config.toolTrim, DEFAULT_CONFIG.toolTrim),
    outputLadder: resolveSection(config.outputLadder, DEFAULT_CONFIG.outputLadder),
    compactionDriver: resolveSection(config.compactionDriver, DEFAULT_CONFIG.compactionDriver),
    // 占位节:enabled=false 时无模块消费,仅保证配置合法(阶段 3b 后开开关)
    memory_bridge: resolveSection(config.memory_bridge, DEFAULT_CONFIG.memory_bridge),
  })
}
