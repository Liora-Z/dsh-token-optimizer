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
    threshold: 5000,           // 字符数阈值,超过且为自然语言才转图
    pageFontSize: 24,          // 渲染字号(大字号=每页字更少,视觉模型读得更准)
    pageMaxHeight: 3000,       // 单页最大高度(小页=可靠;大页=省 token 但脑补)
    visionModel: 'deepseek-v4-flash-vision-exp',
    baseUrl: 'https://api.deepseek.com/v1',  // OpenAI 兼容端点
    prompt: '请阅读图片中的文字内容,输出一份简洁准确的中文摘要,保留关键数字、专有名词和结构要点。只概括原文中出现的内容,不得添加原文没有的信息;无法识别或模糊的部分标注为[无法识别],不要猜测。',
    maxSummaryChars: 2000,     // 摘要上限(替换进上下文的文字长度)
    reasoningBudget: 16384,    // vision 推理模型的思考 token 预留(max_tokens = 摘要上限 + 该预算;
                               // 预算不足时思考吃光额度返回空摘要——真实事故:4096 不够,51 秒思考后 content 为空)
    saveOriginal: true,        // 原始文本落盘(可逆)
    askOnSkip: true,           // 判定为结构性强文本时,交互式询问是否强制转图
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
}

const NUMERIC_KEYS = new Set([
  'threshold', 'compressionRate', 'preserveHeadTail', 'ttl',
  'maxSummaryChars', 'headLines', 'tailLines', 'sampleInterval',
  'minSize', 'maxFileBytes', 'contextLines',
  'structureThreshold', 'shellThreshold', 'errorSummaryChars', 'spillBytes',
  'pressureRatio', 'minTurns', 'minTokens', 'maxCompactionsPerSession', 'contextWindow', 'timeoutMs',
  'reasoningBudget', 'pageFontSize', 'pageMaxHeight',
])
const STRING_KEYS = new Set(['visionModel', 'baseUrl', 'prompt'])
const STRING_ARRAY_KEYS = new Set(['tools', 'allow', 'deny', 'shellTools', 'readTools'])

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
        else assertNumber(key, value)
      } else if (STRING_ARRAY_KEYS.has(key)) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new Error(`dsh-token-optimizer config: "${key}" must be an array of strings`)
        }
      } else if (STRING_KEYS.has(key)) {
        if (typeof value !== 'string') throw new Error(`dsh-token-optimizer config: "${key}" must be a string`)
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
  })
}
