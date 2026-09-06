// 长文本→图片(text2img):超长自然语言文本渲染成图,经 vision API 读图得摘要,
// 以文字摘要替换原文进入上下文。单次实测(一篇 2582 字符文本):原 1530 token → 图片 430 token,省 ~72%。
// 注意:这是单次样本;本功能真正的价值是"会话越长越省"(后续轮次不再携带原文)。
// 设计要点:
// - 仅对"自然语言"文本触发(JSON/代码/配置等需精确的内容跳过,避免 OCR 误差损坏)
// - Windows 用 System.Drawing 渲染(scripts/render-text.ps1),非 Windows 降级为仅落盘
// - 原始文本落盘(可逆),摘要标注来源文件
// - 与 modlens 同构:插件内部完成"图片→文字",进 DSH 适配器的始终是文字
//   (dsh-llm-deepseek 适配器拒绝图片块,这是唯一可行路径)

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
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

// ---- 渲染:Windows System.Drawing ----
function renderToPng(text, pageConfig = {}) {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
      '-text', text, '-outPath', out, '-width', '1200',
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

// ---- vision API 读图得摘要 ----
async function summarizeImage(imagePathOrPaths, config) {
  const { readFileSync } = await import('node:fs')
  const paths = Array.isArray(imagePathOrPaths) ? imagePathOrPaths : [imagePathOrPaths]
  const content = []
  for (const p of paths) {
    const b64 = readFileSync(p).toString('base64')
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })
  }
  content.push({ type: 'text', text: config.prompt })
  const body = {
    model: config.visionModel,
    messages: [{
      role: 'user',
      content,
    }],
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

function saveOriginal(text) {
  try {
    mkdirSync(ORIGINAL_DIR, { recursive: true })
    const file = join(ORIGINAL_DIR, `t2i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

export function createText2imgModule(ctx, config, stats, deps = {}) {
  const renderer = deps.renderToPng ?? renderToPng
  const summarizer = deps.summarizeImage ?? summarizeImage
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  // userQuestions 服务(可选):判定为结构性强文本时交互式询问"是否强制转图"。
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

  // 同一文本只问一次(指纹去重,防多消息/重放重复弹窗)
  const askedFingerprints = new Set()
  function fingerprintOf(text) {
    return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`
  }
  async function maybeAskForce(text, reason, signal) {
    if (config.askOnSkip === false) return false
    if (!userQuestions || typeof userQuestions.ask !== 'function') return false
    if (!currentAgent) {
      console.log('[dsh-token-optimizer] text2img 无法定位当前 agent,跳过询问(直接不转图)')
      return false
    }
    const fp = fingerprintOf(text)
    if (askedFingerprints.has(fp)) return false
    if (askedFingerprints.size > 16) askedFingerprints.clear()
    askedFingerprints.add(fp)
    try {
      const resp = await userQuestions.ask({
        questions: [{
          id: 'force_text2img',
          question: `检测到 ${text.length} 字符的长文本,内容类型为「${reason}」(结构性强/代码类)。默认跳过转图——转图会损坏表格与代码结构,且视觉摘要可能不准确(原文始终落盘可查)。是否强制渲染为图片后摘要?`,
          options: [
            { id: 'no', label: '不转图,直接阅读(推荐)' },
            { id: 'yes', label: '强制转图' },
          ],
        }],
        agent: currentAgent,
        signal,
      })
      const answer = resp?.answers?.[0]
      return answer?.selected?.includes?.('yes') === true
    } catch (err) {
      // NO_PROVIDER / CALLER_NOT_LIVE / 用户取消 / 中断:降级为不转图
      console.log(`[dsh-token-optimizer] text2img 询问未完成(${err?.code ?? err?.message ?? err}),降级为不转图`)
      return false
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
      const content = message?.content
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : ''
      const nl = isNaturalLanguage(text)
      dbg('pre-step: msg len=' + text.length + ' threshold=' + effectiveConfig.threshold + ' isNL=' + (text.length >= effectiveConfig.threshold && nl.ok))
      if (text.length >= effectiveConfig.threshold) {
        let proceed = nl.ok
        if (!nl.ok) {
          // 超长文本被跳过必须可见:静默放行会被误认为"功能没启用"(真实用户踩过)
          stats?.bump('text2img.skipped', 1)
          console.log(`[dsh-token-optimizer] text2img 跳过 ${text.length} 字符文本(原因: ${nl.reason})——结构性强/代码类内容转图会损坏语义`)
          // 交互式询问:要不要强制转图(askOnSkip 配置可关)
          proceed = await maybeAskForce(text, nl.reason, payload?.signal)
          if (proceed) {
            stats?.bump('text2img.forced', 1)
            console.log('[dsh-token-optimizer] text2img 用户选择强制转图')
          }
        }
        if (proceed) {
          dbg('text2img: TRIGGERED, len=' + text.length + (nl.ok ? '' : ' (forced)'))
          console.log(`[dsh-token-optimizer] text2img 触发: ${text.length} 字符${nl.ok ? '' : '(用户强制)'} → 渲染图片 → vision 摘要`)
          try {
          dbg('text2img: rendering...')
          const png = await renderer(text, config)
          dbg('text2img: rendered=' + png)
          const summary = await summarizer(png, effectiveConfig)
          dbg('text2img: summary len=' + (summary?.length ?? -1))
          const originalFile = effectiveConfig.saveOriginal ? saveOriginal(text) : null
          const marker = originalFile ? `(原始全文:${originalFile})` : '(原始全文未落盘)'
          const replaced = `[dsh-token-optimizer text2img: 超长文本已渲染为图片并经视觉模型摘要(摘要可能不准确,引用细节前请核对原文) ${marker}]\n\n${summary}`
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
        } else {
          out.push(message)
          continue
        }
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
