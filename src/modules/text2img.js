// 长文本→图片(text2img):超长自然语言文本渲染成图,经 vision API 读图得摘要,
// 以文字摘要替换原文进入上下文。单次实测(一篇 2582 字符文本):原 1530 token → 图片 430 token,省 ~72%。
// 注意:这是单次样本;本功能真正的价值是"会话越长越省"(后续轮次不再携带原文)。
// 设计要点:
// - v2.1 起达阈值一律弹窗询问(不限内容类型),内容类型决定推荐项与超时默认值——
//   自然语言→转图摘要,结构性强→直接阅读原文(v2.0"纯散文自动转图"让模型读不到
//   原文细节的真实事故驱动)。askOnSkip=false 回退 v2.0 自动行为。
// - 动态分辨率分档(640×360 / 1280×720 / 1920×1080),大档位提高字号保持页密度
//   (密度超 ~3千字/页会触发视觉模型脑补——三次幻觉事故根因)
// - 内容 hash → 摘要磁盘缓存,跨会话命中 0 API 调用
// - Windows 用 System.Drawing 渲染(scripts/render-text.ps1),非 Windows 降级为仅落盘
// - 原始文本落盘(可逆),摘要标注来源文件 + "引用细节前必须 read 原文核对"堵漏
// - 与 modlens 同构:插件内部完成"图片→文字",进 DSH 适配器的始终是文字
//   (dsh-llm-deepseek 适配器拒绝图片块,这是唯一可行路径)

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 调试日志:默认关闭,需要排查时设 DSH_TOKEN_OPTIMIZER_DEBUG=1 才写盘
const DEBUG_LOG = 'D:\\dsh\\text2img-debug.log'
const DEBUG_ENABLED = !!process.env.DSH_TOKEN_OPTIMIZER_DEBUG
function dbg(msg) {
  if (!DEBUG_ENABLED) return
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch {}
}
const ORIGINAL_DIR = join(homedir(), '.dsh', 'token-optimizer', 'text2img-originals')
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/render-text.ps1', import.meta.url))

// ---- 内容类型判断:仅自然语言 ----
const CODE_LIKE = /(^|\n)\s*(function|const|let|var|import|export|class|def |public |private |<[a-zA-Z][^>]*>|[{}\[\];]\s*$|\/\/|\/\*|#!)/m
const JSON_LIKE = /^[\s]*[\[{]/
function isNaturalLanguage(text) {
  if (JSON_LIKE.test(text)) return { ok: false, reason: 'json-like' }
  const lines = text.split(/\r?\n/)
  const total = lines.length
  if (total === 0) return { ok: false, reason: 'empty' }

  // 按 ``` / ~~~ 代码围栏划分:围栏内的行、以及非围栏但像代码的行,都计为“代码类”
  let inFence = false
  let codeLike = 0
  let configLike = 0
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; codeLike++; continue }
    if (inFence) { codeLike++; continue }
    if (CODE_LIKE.test(line)) { codeLike++; continue }
    // 配置类行:缩进的 “key: value” / “key=value”(YAML/properties/ini 等)
    if (/^[ \t]+[A-Za-z0-9_.\-/]+:\s*/.test(line) || /^[ \t]+\S+=\s*/.test(line)) configLike++
  }

  // ① 代码/围栏占比过高 → 判为代码或结构文件,跳过(避免 OCR 损坏)
  if (codeLike / total > 0.5) return { ok: false, reason: 'code-like' }
  // ② 几乎都是缩进 key:value / key=value → 配置文件,跳过
  if (total > 8 && configLike / total > 0.5) return { ok: false, reason: 'config-like' }
  // ③ 结构性太强:纯分隔线行(----- / ===== / +----+ 等表格框线)≥5 条且行数多
  //    (v1 是"全文任意一处 10+ 连续分隔符就拒",误伤含单条分隔线的长文;
  //     改为按纯分隔线行数统计,普通分隔标题不受影响)
  let separatorLines = 0
  for (const line of lines) {
    if (/^\s*[-=_*|+]{10,}\s*$/.test(line)) separatorLines++
  }
  if (total > 200 && separatorLines >= 5) return { ok: false, reason: 'structural' }
  return { ok: true, reason: 'pass' }
}

// ---- 动态分辨率分档 ----
// 密度原则:已验证可靠的页密度 ≈ 字号24 + 宽1200 ≈ 1千字/页;超过 ~3千字/页会脑补。
// 大档位同比例放大字号,保持密度(1920×1080 用 36 号 ≈ 1250 字/页)。
// 2026-09-09 实测(YaHei 行高 ≈1.9×字号):800×450 ≈160 字/页、1440×810 ≈490、1920×1080@36 ≈440。
function tierFor(chars, config) {
  if (!config.dynamicResolution) {
    return { width: config.renderWidth, pageFontSize: config.pageFontSize, pageMaxHeight: config.pageMaxHeight }
  }
  for (const t of config.resolutionTiers) {
    if (chars <= t.maxChars) return { width: t.width, pageFontSize: t.fontSize, pageMaxHeight: t.height }
  }
  const last = config.resolutionTiers[config.resolutionTiers.length - 1]
  return { width: last.width, pageFontSize: last.fontSize, pageMaxHeight: last.height }
}

// 经济账估算(弹窗展示,让用户在知情下选择):
// - 原文 token ≈ 字数 × 0.7(中英混排 DeepSeek 大约 0.65-0.75 token/字)
// - 图片 token ≈ 页数 × 60(实测:1200×3000 大页 ~72/图,800×450 小页更少,取 60 保守)
// - 与 resolutionTiers 顺序一一对应的实测每页密度
const TIER_CHARS_PER_PAGE = [160, 490, 440]
function estimateEconomics(text, config) {
  const origTokens = Math.round(text.length * 0.7)
  let charsPerPage = 400 // fallback(dynamicResolution 关闭时的旧分页近似)
  if (config.dynamicResolution) {
    for (let i = 0; i < config.resolutionTiers.length; i++) {
      if (text.length <= config.resolutionTiers[i].maxChars) { charsPerPage = TIER_CHARS_PER_PAGE[i]; break }
    }
  }
  const pages = Math.max(1, Math.ceil(text.length / charsPerPage))
  const imageTokens = pages * 60
  const cap = summaryCapFor(text.length, config)
  return { origTokens, pages, imageTokens, cap }
}
// 摘要上限 = min(maxSummaryChars, 输入×maxSummaryRatio),下限 200——
// 保证替换后一定比原文短(否则短文本会因摘要超长保留原文,vision 白烧)
function summaryCapFor(len, config) {
  return Math.min(config.maxSummaryChars, Math.max(200, Math.round(len * config.maxSummaryRatio)))
}

// ---- 渲染:Windows System.Drawing ----
function renderToPng(text, pageConfig = {}) {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
      '-text', text, '-outPath', out, '-width', String(pageConfig.width ?? 1200),
      '-fontSize', String(pageConfig.pageFontSize ?? 24),
      '-maxHeight', String(pageConfig.pageMaxHeight ?? 3000),
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) {
        // 分页渲染:脚本在 stdout 逐行输出分页文件路径(首行是 "OK ..." 摘要行)
        const extra = stdout.split(/\r?\n/).map((s) => s.trim())
          .filter((s) => s && /\.png$/i.test(s) && s !== out)
        const pages = [out, ...extra].filter((p) => existsSync(p))
        resolve(pages)
      } else {
        reject(new Error(`render failed (${code}): ${stderr.slice(0, 200)}`))
      }
    })
  })
}

// ---- 摘要磁盘缓存:内容 hash → 摘要,跨会话命中 0 API 调用 ----
// 条目同时记录首次转换时的原文落盘路径:DSH 每个 step 都会重发 inbox 里的
// 同一消息,缓存命中时复用该路径,避免同一文本反复落盘重复原文文件
// (实测事故:同一文本 7 次出现 → 7 个重复原文文件)。
function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeSummaryCache(cacheDir) {
  // promptHash:提示词变更后旧摘要作废——坏摘要被缓存复用会把事故永久化(实测:
  // 知乎长文被只摘要了版权块,改提示词后同内容必须重新走 vision)
  function read(hash, promptHash) {
    try {
      const raw = readFileSync(join(cacheDir, `${hash}.json`), 'utf8')
      const data = JSON.parse(raw)
      if (data.promptHash && data.promptHash !== promptHash) return null
      if (typeof data.summary === 'string' && data.summary.trim().length > 0) {
        return { summary: data.summary, original: typeof data.original === 'string' ? data.original : null }
      }
    } catch { /* 未命中/损坏:视为无缓存 */ }
    return null
  }
  function write(hash, summary, original, promptHash) {
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(join(cacheDir, `${hash}.json`), JSON.stringify({
        summary, original: original ?? null, promptHash, savedAt: new Date().toISOString(),
      }), 'utf8')
    } catch { /* 缓存写失败不阻断主流程 */ }
  }
  return { read, write }
}

// ---- vision API 读图得摘要(分批 + 合并) ----
// 实测事故:flash-vision 一次读 8+ 页会只概括开头几页并脑补"原文在此处结束",
// 正文后续全丢。结构修复:按 pagesPerBatch 分批做 vision 调用(强制每批全覆盖),
// 再纯文本合并;每张图前加"第 i 页/共 N 页"标记帮助模型跟踪进度。
export function splitChunks(paths, batchSize) {
  const out = []
  for (let i = 0; i < paths.length; i += batchSize) out.push(paths.slice(i, i + batchSize))
  return out
}

function buildVisionContent(paths, prompt, pageOffset, totalPages) {
  const content = []
  paths.forEach((p, i) => {
    content.push({ type: 'text', text: `[第 ${pageOffset + i + 1} 页 / 共 ${totalPages} 页]` })
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(p).toString('base64')}` } })
  })
  content.push({ type: 'text', text: prompt })
  return content
}

async function callVisionApi(content, config) {
  const body = {
    model: config.visionModel,
    messages: [{ role: 'user', content }],
    // deepseek-v4-flash-vision-exp 是推理模型:会先消耗 reasoning tokens 再输出 content。
    // 若 max_tokens 太小,思考 token 会把预算吃光,content 为 0(空摘要)。
    // 真实事故:预留 4096 时,51 秒思考后返回空摘要。思考预算可配置,默认 16384。
    max_tokens: config.maxSummaryChars + (config.reasoningBudget ?? 16384),
  }
  const apiKey = typeof config.resolveApiKey === 'function'
    ? await config.resolveApiKey()
    : process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set (no process.env and no ctx.credentials resolver)')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const resp = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`vision API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = await resp.json()
    const summary = data?.choices?.[0]?.message?.content ?? ''
    if (typeof summary !== 'string' || summary.trim().length === 0) throw new Error('empty vision summary')
    return summary.slice(0, config.maxSummaryChars)
  } finally {
    clearTimeout(timer)
  }
}

async function summarizeImage(imagePathOrPaths, config) {
  const paths = Array.isArray(imagePathOrPaths) ? imagePathOrPaths : [imagePathOrPaths]
  const batch = Math.max(1, config.pagesPerBatch ?? 4)
  if (paths.length <= batch) {
    return callVisionApi(buildVisionContent(paths, config.prompt, 0, paths.length), config)
  }
  // 分批摘要:每批强制逐页全覆盖
  const chunks = splitChunks(paths, batch)
  const partSummaries = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const offset = ci * batch
    const chunkPrompt = `以下是同一篇长文的第 ${offset + 1}-${offset + chunk.length} 页(共 ${paths.length} 页)。${config.prompt}`
    partSummaries.push(await callVisionApi(buildVisionContent(chunk, chunkPrompt, offset, paths.length), config))
  }
  // 纯文本合并(不再带图):不遗漏任何一段
  const mergePrompt = `以下是同一篇长文按原文顺序拆分的 ${partSummaries.length} 段摘要。请把它们合并成一篇简洁准确的中文摘要,保留关键数字、专有名词和结构要点;不要遗漏任何一段的核心内容;不要添加任何新信息。\n\n${partSummaries.map((s, i) => `【第 ${i + 1} 段】\n${s}`).join('\n\n')}`
  return callVisionApi([{ type: 'text', text: mergePrompt }], config)
}

function saveOriginal(text, dir = ORIGINAL_DIR) {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

export function createText2imgModule(ctx, config, stats, deps = {}) {
  const renderer = deps.renderToPng ?? renderToPng
  const summarizer = deps.summarizeImage ?? summarizeImage
  const summaryCache = makeSummaryCache(deps.cacheDir ?? join(homedir(), '.dsh', 'token-optimizer', 'text2img-summary-cache'))
  const originalDir = deps.originalDir ?? ORIGINAL_DIR
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  // userQuestions 服务(可选):达阈值时询问"转图摘要 / 直接阅读原文"。
  // 核心事实:web 端的 provider(dsh-host-apiproxy)强制要求 request.agent
  // (无 agent 直接 reject ASK_MISSING_AGENT),所以必须带上 agent——
  // pre-step 载荷里没有 agent,从 agent/status 事件跟踪"当前正在跑的 agent"
  // (running 事件先于该 agent 的 turn 内 pre-step 发生)。
  let userQuestions
  let currentAgent
  try {
    ctx.inject?.(['userQuestions'], (sctx) => {
      userQuestions = sctx.userQuestions
    })
  } catch { /* inject 不可用:静默跳过询问 */ }
  const onStatus = (payload) => {
    if (payload?.status === 'running' && payload?.agent) currentAgent = payload.agent
  }
  ctx.on?.('agent/status', onStatus)
  listeners.push(() => ctx.off?.('agent/status', onStatus))

  // 同一文本只问一次:指纹 → 用户上次的选择(防多消息/重放重复弹窗)
  const askedFingerprints = new Map()
  function fingerprintOf(text) {
    return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`
  }
  // 内容类型的默认路径(询问超时/不可用/弹窗配额耗尽时的回退方向)
  function defaultPathFor(nl) {
    return nl.ok ? 'img' : 'raw'
  }
  let askCount = 0 // 本会话已弹窗次数(maxAsksPerSession 配额)

  // 带超时的 ask:provider 只在 signal abort 时结束(无内置超时),超时由插件侧驱动。
  // 超时 → abort 弹窗(web 端 dismiss)→ 按内容类型默认执行。
  function askWithTimeout(req, timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let timedOut = false
      const timer = timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        : null
      const ext = req.signal
      const onExtAbort = () => controller.abort()
      if (ext && typeof ext.addEventListener === 'function') {
        if (ext.aborted) { if (timer) clearTimeout(timer); controller.abort() }
        else ext.addEventListener('abort', onExtAbort, { once: true })
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (ext && typeof ext.removeEventListener === 'function') ext.removeEventListener('abort', onExtAbort)
      }
      userQuestions.ask({ ...req, signal: controller.signal })
        .then((resp) => { cleanup(); resolve({ resp, timedOut: false }) })
        .catch((err) => {
          cleanup()
          if (timedOut) resolve({ resp: null, timedOut: true })
          else reject(err)
        })
    })
  }

  // v2.1 主路径:达阈值一律询问。返回 'img'(转图摘要)或 'raw'(直接阅读原文)。
  async function choosePath(text, nl, signal) {
    const fp = fingerprintOf(text)
    const prev = askedFingerprints.get(fp)
    if (prev) return prev
    if (askedFingerprints.size > 64) askedFingerprints.clear()

    // 询问关闭:回退 v2.0 自动行为(自然语言自动转图/结构性强跳过)
    if (config.askOnSkip === false) return defaultPathFor(nl)
    // 弹窗配额耗尽:按内容类型默认静默执行
    if (config.maxAsksPerSession > 0 && askCount >= config.maxAsksPerSession) {
      const def = defaultPathFor(nl)
      askedFingerprints.set(fp, def)
      console.log(`[dsh-token-optimizer] text2img 本会话弹窗已达上限(${config.maxAsksPerSession}),按内容类型默认: ${def === 'img' ? '转图摘要' : '直接阅读原文'}`)
      return def
    }
    // 询问不可用:静默降级为读原文(宁可省不到 token,不可静默丢细节)
    if (!userQuestions || typeof userQuestions.ask !== 'function') {
      console.log('[dsh-token-optimizer] text2img 无 userQuestions 服务,跳过询问(直接阅读原文)')
      return 'raw'
    }
    if (!currentAgent) {
      console.log('[dsh-token-optimizer] text2img 无法定位当前 agent,跳过询问(直接阅读原文)')
      return 'raw'
    }

    // 推荐项放第一位(label 带"(推荐)")——选项协议没有高亮字段
    const imgOpt = { id: 'text2img_convert', label: nl.ok ? '转图摘要(推荐)' : '转图摘要' }
    const rawOpt = { id: 'text2img_raw', label: nl.ok ? '直接阅读原文' : '直接阅读原文(推荐)' }
    const options = nl.ok ? [imgOpt, rawOpt] : [rawOpt, imgOpt]
    // 经济账:短文本转图首轮可能不赚(图片基础 token 开销),估算展示给用户
    const est = estimateEconomics(text, config)
    const econ = `原文约 ${est.origTokens} token;转图 ≈ ${est.pages} 页图片(约 ${est.imageTokens} token)+ 摘要 ≤${est.cap} 字。短文本首轮可能不省,长会话后续轮次才赚。`
    const question = nl.ok
      ? `检测到 ${text.length} 字符的自然语言长文本。${econ}摘要可能不准确(原文始终落盘可查)。如何处理?`
      : `检测到 ${text.length} 字符的长文本,内容类型为「${nl.reason}」(结构性强/代码类)。${econ}转图会损坏表格与代码结构,且视觉摘要可能不准确(原文始终落盘可查)。如何处理?`
    try {
      stats?.bump('text2img.asked', 1)
      askCount += 1
      const { resp, timedOut } = await askWithTimeout({
        questions: [{ id: 'text2img_path', question, options }],
        agent: currentAgent,
        signal,
      }, config.askTimeoutMs)
      let chosen
      if (timedOut) {
        chosen = defaultPathFor(nl)
        console.log(`[dsh-token-optimizer] text2img 询问超时(${config.askTimeoutMs}ms),按内容类型默认: ${chosen === 'img' ? '转图摘要' : '直接阅读原文'}`)
      } else {
        const selected = resp?.answers?.[0]?.selected ?? []
        const isImg = selected.some((s) => s === imgOpt.label || s === imgOpt.id)
        chosen = isImg ? 'img' : 'raw'
      }
      if (chosen === 'img' && !nl.ok) stats?.bump('text2img.forced', 1)
      askedFingerprints.set(fp, chosen)
      return chosen
    } catch (err) {
      // NO_PROVIDER / CALLER_NOT_LIVE / 用户取消 / 中断:降级为读原文(fail-safe)
      console.log(`[dsh-token-optimizer] text2img 询问未完成(${err?.code ?? err?.message ?? err}),降级为直接阅读原文`)
      return 'raw'
    }
  }

  // 注入 API key 解析:与 dsh-llm-deepseek 相同的凭据解析模式
  const resolveApiKey = async () => {
    dbg('resolveApiKey: begin')
    try {
      const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
      dbg('resolveApiKey: credentials=' + (credentials ? typeof credentials.resolve : 'undefined'))
      if (credentials && typeof credentials.resolve === 'function') {
        const ref = 'DEEPSEEK_API_KEY'
        const hit = await credentials.resolve(ref)
        dbg('resolveApiKey: hit=' + (hit ? 'yes' : 'undefined'))
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      } else {
        dbg('resolveApiKey: credentials.resolve missing')
      }
    } catch (e) {
      dbg('resolveApiKey: credentials error: ' + (e?.message ?? e))
    }
    const ambient = process.env.DEEPSEEK_API_KEY
    dbg('resolveApiKey: ambient=' + (ambient ? 'set' : 'missing'))
    if (ambient && ambient.length > 0) return ambient
    return null
  }
  const effectiveConfig = { ...config, resolveApiKey }

  const handler = async (payload, next) => {
    dbg('pre-step: begin')
    const decision = await next()
    if (!decision || decision.kind !== 'enter') { dbg('pre-step: not enter, kind=' + decision?.kind); return decision }
    const messages = decision.messages
    if (!Array.isArray(messages) || messages.length === 0) { dbg('pre-step: no messages'); return decision }

    const out = []
    let changed = false
    let savedChars = 0
    for (const message of messages) {
      // 只处理真实用户消息(source.kind='user')。
      // DSH 每轮注入的运行时上下文快照(dsh-system-prompt,source.kind='plugin',
      // 含文件策略/项目记忆,随记忆增长且每轮略变)不是用户输入——转图会误伤,
      // 且快照变化让指纹去重失效、每轮重复弹窗(实测事故:30字短指令+2864字符快照,
      // 弹窗指向快照而非指令)。
      const srcKind = message?.source?.kind
      if (srcKind !== undefined && srcKind !== 'user') {
        out.push(message)
        continue
      }
      const content = message?.content
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : ''
      dbg('pre-step: msg len=' + text.length + ' threshold=' + effectiveConfig.threshold)
      if (text.length < effectiveConfig.threshold) {
        out.push(message)
        continue
      }
      const nl = isNaturalLanguage(text)
      const path = await choosePath(text, nl, payload?.signal)
      if (path === 'raw') {
        // 超长文本不转图必须可见:静默放行会被误认为"功能没启用"(真实用户踩过)
        stats?.bump('text2img.skipped', 1)
        console.log(`[dsh-token-optimizer] text2img 未转图,原文保留(${text.length} 字符${nl.ok ? '' : ',原因: ' + nl.reason})`)
        out.push(message)
        continue
      }

      dbg('text2img: TRIGGERED, len=' + text.length)
      console.log(`[dsh-token-optimizer] text2img 触发: ${text.length} 字符 → 渲染图片 → vision 摘要`)
      try {
        const hash = hashOf(text)
        const promptHash = hashOf(effectiveConfig.prompt)
        const cached = effectiveConfig.summaryCache ? summaryCache.read(hash, promptHash) : null
        let summary
        let cacheHit = false
        let originalFile = null
        if (cached) {
          cacheHit = true
          summary = cached.summary
          // 复用首次转换的原文路径;DSH 每 step 重发同一消息时不再重复落盘
          if (effectiveConfig.saveOriginal) {
            originalFile = cached.original && existsSync(cached.original) ? cached.original : saveOriginal(text, originalDir)
            if (!cached.original) summaryCache.write(hash, summary, originalFile, promptHash) // 回填路径
          }
          stats?.bump('text2img.cacheHits', 1)
          dbg('text2img: cache HIT, skip render+vision')
          console.log('[dsh-token-optimizer] text2img 摘要命中磁盘缓存,跳过渲染与 vision 调用')
        } else {
          dbg('text2img: rendering...')
          const tier = tierFor(text.length, effectiveConfig)
          const png = await renderer(text, tier)
          dbg('text2img: rendered=' + png)
          // 摘要上限随输入缩放:保证替换后一定比原文短
          const cap = summaryCapFor(text.length, effectiveConfig)
          summary = await summarizer(png, { ...effectiveConfig, maxSummaryChars: cap })
          dbg('text2img: summary len=' + (summary?.length ?? -1) + ' cap=' + cap)
          originalFile = effectiveConfig.saveOriginal ? saveOriginal(text, originalDir) : null
          if (effectiveConfig.summaryCache) summaryCache.write(hash, summary, originalFile, promptHash)
        }
        const marker = originalFile ? `(原始全文:${originalFile})` : '(原始全文未落盘)'
        const replaced = `[dsh-token-optimizer text2img: 超长文本已渲染为图片并经视觉模型摘要(摘要可能不准确;引用任何细节前必须先 read 原文文件核对,禁止凭摘要猜测) ${marker}${cacheHit ? '(摘要命中磁盘缓存)' : ''}]\n\n${summary}`
        if (replaced.length < text.length) {
          savedChars += text.length - replaced.length
          out.push({ ...message, content: [{ type: 'text', text: replaced }] })
          changed = true
          stats?.bump('text2img.messages', 1)
          stats?.bump('text2img.savedChars', savedChars)
          stats?.addSample({ module: 'text2img', savedChars: text.length - replaced.length })
          dbg('text2img: REPLACED, saved ' + (text.length - replaced.length) + ' chars')
          continue
        } else {
          dbg('text2img: replaced not shorter (' + replaced.length + ' >= ' + text.length + '), keep original')
        }
      } catch (error) {
        stats?.bump('text2img.failures', 1)
        console.warn(`[dsh-token-optimizer] text2img 失败(${error?.message ?? error}),保留原文`)
        dbg('text2img: FAILED: ' + (error?.message ?? error))
      }
      out.push(message)
    }
    return changed ? { ...decision, messages: out } : decision
  }

  ctx.on('agent/pre-step', handler)
  listeners.push(() => ctx.off('agent/pre-step', handler))
  return () => {
    for (const off of listeners) off()
  }
}
