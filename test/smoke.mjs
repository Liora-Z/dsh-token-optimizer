// 单进程 smoke 验证(替代 node --test,规避沙箱 spawn EPERM)。
// 用法: node test/smoke.mjs

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createText2imgModule, splitChunks } from '../src/modules/text2img.js'
import { createCacheModule } from '../src/modules/cache.js'
import { createMonitorModule } from '../src/modules/monitor.js'
import { createFileDiffModule } from '../src/modules/fileDiff.js'
import { createToolTrimModule } from '../src/modules/toolTrim.js'
import { createOutputLadderModule } from '../src/modules/outputLadder.js'
import { createCompactionDriverModule } from '../src/modules/compactionDriver.js'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

function makeFakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) { handlers.set(event, handler) },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
}

// 模块替换后 content 可能是 string 或 [{type:'text',text}] 数组(OpenAI 风格块),
// 断言前统一抽取文本,兼容两种形状
function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

console.log('== config ==')
{
  const cfg = resolveConfig({})
  check('默认 structureThreshold 10000', cfg.outputLadder.structureThreshold === 10000)
  check('默认 ttl 3600', cfg.cache.ttl === 3600)
  check('默认 pressureRatio 0.45', cfg.compactionDriver.pressureRatio === 0.45)
  // v2.1 新默认值
  check('v2.1 默认 text2img.threshold 1000', cfg.text2img.threshold === 1000)
  check('v2.1 默认 askTimeoutMs 120000', cfg.text2img.askTimeoutMs === 120000)
  check('v2.1 默认 dynamicResolution true', cfg.text2img.dynamicResolution === true)
  check('v2.1 默认 summaryCache true', cfg.text2img.summaryCache === true)
  check('v2.1 默认分档 3 档', cfg.text2img.resolutionTiers.length === 3 && cfg.text2img.resolutionTiers[2].maxChars === Infinity)
  check('v2.1 pagesPerBatch 默认 4', cfg.text2img.pagesPerBatch === 4)
  check('memory_bridge 占位节 enabled=false', cfg.memory_bridge.enabled === false)
  check('memory_bridge sync_dir 默认', cfg.memory_bridge.sync_dir === '~/.dsh-memory')
  let threw = false
  try { resolveConfig({ outputLadder: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
  threw = false
  try { resolveConfig({ outputLadder: { structureThreshold: -5 } }) } catch { threw = true }
  check('负数报错', threw)
  threw = false
  try { resolveConfig({ text2img: { resolutionTiers: [{ maxChars: 500, width: 640, height: 360, fontSize: 24 }, { maxChars: 300, width: 1280, height: 720, fontSize: 24 }] } }) } catch { threw = true }
  check('分档 maxChars 未递增报错', threw)
  threw = false
  try { resolveConfig({ text2img: { resolutionTiers: [{ maxChars: 2000, width: 9000, height: 360, fontSize: 24 }] } }) } catch { threw = true }
  check('分档超视觉 API 长边限制报错', threw)
  // v1 退役节静默忽略不抛
  let legacyThrew = false
  try { resolveConfig({ compress: { threshold: 1 }, pruning: {}, dedup: {}, sample: {} }) } catch { legacyThrew = true }
  check('退役节静默忽略不抛', !legacyThrew)
}

console.log('== text2img 完整流程(askOnSkip=false 自动路径,mock 渲染+摘要) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  // mock:渲染返回假路径,摘要返回固定文本
  const deps = {
    renderToPng: async (text) => '/tmp/fake.png',
    summarizeImage: async (png, cfg) => `[摘要] 共 ${Math.floor(png.length)} 字节图片,内容摘要:这是一段测试文本的简要概括。`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  const longText = '这是' + '一段很长很长很长很长很长很长很长很长的自然语言文本内容,用于测试摘要替换。'.repeat(10)
  const nextLong = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dLong = await ctx.emit('agent/pre-step', { signal: {} }, nextLong)
  check('长自然语言文本触发 text2img', /text2img/.test(txt(dLong.messages[0].content)))
  check('text2img 内容包含摘要', /\[摘要\]/.test(txt(dLong.messages[0].content)))
  check('text2img 替换后更短', txt(dLong.messages[0].content).length < longText.length)
  check('text2img 摘要标注含核对堵漏', /先 read 原文文件核对/.test(txt(dLong.messages[0].content)))
  check('text2img.messages=1', stats.snapshot().counters['text2img.messages'] === 1)
  check('text2img.savedChars>0', stats.snapshot().counters['text2img.savedChars'] > 0)
  // JSON 不触发(内容类型判断)
  const json = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i })))
  const nextJson = async () => ({ kind: 'enter', messages: [{ content: json }] })
  const dJson = await ctx.emit('agent/pre-step', { signal: {} }, nextJson)
  check('JSON 不触发 text2img', dJson.messages[0].content === json)
  // 短文本不触发
  const nextShort = async () => ({ kind: 'enter', messages: [{ content: 'hi there' }] })
  const dShort = await ctx.emit('agent/pre-step', { signal: {} }, nextShort)
  check('短文本不触发 text2img', dShort.messages[0].content === 'hi there')

  // 渲染失败时保留原文
  const ctx2 = makeFakeCtx()
  const stats2 = createStats()
  const depsFail = {
    renderToPng: async () => { throw new Error('render boom') },
    summarizeImage: async () => 'x',
  }
  createText2imgModule(ctx2, { ...resolveConfig({}).text2img, threshold: 100, askOnSkip: false, summaryCache: false }, stats2, depsFail)
  const nextFail = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dFail = await ctx2.emit('agent/pre-step', { signal: {} }, nextFail)
  check('渲染失败保留原文', dFail.messages[0].content === longText)
  check('text2img.failures=1', stats2.snapshot().counters['text2img.failures'] === 1)
}

console.log('== text2img v2.1 摘要上限随输入缩放 ==')
{
  const ctx = makeFakeCtx()
  let capSeen = 0
  const deps = {
    renderToPng: async () => '/tmp/fake.png',
    // 模拟真实 summarizeImage:按传入的 maxSummaryChars 截断
    summarizeImage: async (png, cfg) => { capSeen = cfg.maxSummaryChars; return '长'.repeat(1500).slice(0, cfg.maxSummaryChars) },
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, createStats(), deps)
  const text800 = '这是一段' + '用于验证摘要上限缩放的自然语言长文本。'.repeat(20) // ~600-800 字
  const d = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: text800 }] }))
  const expectedCap = Math.min(2000, Math.max(200, Math.round(text800.length * 0.4)))
  check('v2.1 摘要上限按输入缩放(0.4 比)', capSeen === expectedCap && capSeen < 2000)
  check('v2.1 缩放后替换一定更短', txt(d.messages[0].content).length < text800.length)
  check('v2.1 缩放摘要不超上限', /text2img/.test(txt(d.messages[0].content)))
}

console.log('== text2img 分批摘要分块 ==')
{
  const c9 = splitChunks(Array.from({ length: 9 }, (_, i) => `p${i}`), 4)
  check('splitChunks 9 页/批 4 → [4,4,1]', c9.length === 3 && c9[0].length === 4 && c9[1].length === 4 && c9[2].length === 1)
  const c5 = splitChunks([1, 2, 3, 4, 5], 4)
  check('splitChunks 5 页/批 4 → [4,1]', c5.length === 2 && c5[1].length === 1)
}

// 多页渲染:renderer 返回路径数组,应全部送入摘要
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => ['/tmp/fake-p1.png', '/tmp/fake-p2.png'],
    summarizeImage: async (pngs) => `[摘要] 共 ${pngs.length} 页图片`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  const multiText = '多页测试' + '这是一段用于多页渲染测试的长文本内容。'.repeat(20)
  const nextMulti = async () => ({ kind: 'enter', messages: [{ role: 'user', content: multiText }] })
  const dMulti = await ctx.emit('agent/pre-step', { signal: {} }, nextMulti)
  check('多页渲染触发 text2img', /text2img/.test(txt(dMulti.messages[0].content)))
  check('多页摘要包含页数', /共 2 页/.test(txt(dMulti.messages[0].content)))
  check('多页统计计数', stats.snapshot().counters['text2img.messages'] === 1)
}

console.log('== text2img 结构过滤(askOnSkip=false 自动路径) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => '/tmp/fake.png',
    summarizeImage: async () => '[摘要] 测试摘要。',
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }, stats, deps)
  // 1) ≥5 条纯分隔线 + >200 行 → 拒绝(跳过计数+不替换)
  const sepLines = ['----------------', '================', '+----+----+', '----------------', '**********', ...Array.from({ length: 250 }, (_, i) => `这是第 ${i} 行正文内容,用于测试结构强度过滤。`)].join('\n')
  const dSep = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: sepLines }] }))
  check('text2img 结构性文本拒绝', dSep.messages[0].content === sepLines)
  check('text2img.skipped 计数', stats.snapshot().counters['text2img.skipped'] >= 1)
  // 2) 只有 1 条分隔线的长文 → 通过(v1 会误伤)
  const oneSep = ['---', ...Array.from({ length: 205 }, (_, i) => `段落 ${i}:这是纯自然语言正文内容,用于验证单条分隔线不误伤。`)].join('\n')
  const dOne = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [{ content: oneSep }] }))
  check('text2img 单分隔线长文触发', /text2img/.test(txt(dOne.messages[0].content)))
}

console.log('== text2img v2.1 达阈值询问(askOnSkip=true 主路径) ==')
{
  const mkCtxWithAsk = (askImpl) => {
    const ctx = makeFakeCtx()
    ctx.inject = (keys, cb) => {
      const sctx = {}
      if (keys.includes('userQuestions')) sctx.userQuestions = { ask: askImpl }
      cb(sctx)
    }
    return ctx
  }
  const mkDeps = () => ({
    renderToPng: async () => '/tmp/fake.png',
    summarizeImage: async () => '[摘要] 询问流程测试摘要。',
  })
  const nlText = '这是一段' + '用于询问机制测试的自然语言长文本内容。'.repeat(15)
  const structural = ['----------------', '================', '+----+----+', '----------------', '**********', ...Array.from({ length: 250 }, (_, i) => `这是第 ${i} 行正文内容,用于测试结构强度过滤。`)].join('\n')
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  const markRunning = (ctx) => ctx.emit('agent/status', { agent: { id: 'root1' }, status: 'running' })
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, summaryCache: false }

  // 1) 自然语言达阈值 → 询问;推荐项(转图)在第一位;ask 请求必须带 agent(web provider 强制)
  {
    let askCount = 0
    let askGotAgent = false
    let firstLabel = ''
    let questionText = ''
    const ctx = mkCtxWithAsk(async (req) => {
      askCount += 1
      askGotAgent = !!req?.agent
      firstLabel = req.questions[0].options[0].label
      questionText = req.questions[0].question
      return { answers: [{ id: 'text2img_path', selected: ['转图摘要(推荐)'] }] }
    })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 自然语言达阈值先询问', askCount === 1 && askGotAgent)
    check('v2.1 自然语言推荐项转图在首位', /转图摘要/.test(firstLabel))
    check('v2.1 弹窗含经济账估算', /token/.test(questionText) && /页图片/.test(questionText) && /摘要 ≤/.test(questionText))
    check('v2.1 选转图 → 摘要替换', /text2img/.test(txt(d.messages[0].content)))
    check('v2.1 asked 计数', stats.snapshot().counters['text2img.asked'] === 1)
  }
  // 2) 自然语言选"直接阅读原文" → 原文保留
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['直接阅读原文'] }] } })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 选读原文 → 原文保留', d.messages[0].content === nlText)
    check('v2.1 读原文 skipped 计数', stats.snapshot().counters['text2img.skipped'] === 1)
  }
  // 3) 结构性强 → 推荐项(读原文)在第一位;选转图 → forced 计数
  {
    let firstLabel = ''
    const ctx = mkCtxWithAsk(async (req) => {
      firstLabel = req.questions[0].options[0].label
      return { answers: [{ id: 'text2img_path', selected: ['转图摘要'] }] }
    })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('v2.1 结构性强推荐项读原文在首位', /直接阅读原文/.test(firstLabel))
    check('v2.1 结构性强选转图 → 转换', /text2img/.test(txt(d.messages[0].content)))
    check('v2.1 forced 计数', stats.snapshot().counters['text2img.forced'] === 1)
  }
  // 4) 询问超时 → 按内容类型默认(自然语言转图 / 结构性强读原文)
  {
    const mkTimeoutAsk = () => async (req) => new Promise((_, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('ASK_ABORTED')))
    })
    {
      const ctx = mkCtxWithAsk(mkTimeoutAsk())
      createText2imgModule(ctx, { ...base, askOnSkip: true, askTimeoutMs: 60 }, createStats(), mkDeps())
      await markRunning(ctx)
      const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
      check('v2.1 超时默认:自然语言→转图', /text2img/.test(txt(d.messages[0].content)))
    }
    {
      const ctx = mkCtxWithAsk(mkTimeoutAsk())
      createText2imgModule(ctx, { ...base, askOnSkip: true, askTimeoutMs: 60 }, createStats(), mkDeps())
      await markRunning(ctx)
      const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
      check('v2.1 超时默认:结构性强→读原文', d.messages[0].content === structural)
    }
  }
  // 5) ask 抛错(NO_PROVIDER 等)→ 自然语言也降级为读原文(fail-safe,不再自动转图)
  {
    const ctx = mkCtxWithAsk(async () => { throw new Error('NO_PROVIDER') })
    const stats = createStats()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 ask 抛错自然语言降级读原文', d.messages[0].content === nlText)
  }
  // 6) 没有 running 事件(拿不到当前 agent)→ 不询问直接读原文
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 无当前 agent 不询问直接读原文', d.messages[0].content === nlText && askCount === 0)
  }
  // 7) 无 userQuestions 服务(fake ctx 无 inject)→ 读原文,不崩
  {
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 无 provider 读原文不崩', d.messages[0].content === nlText)
  }
  // 8) askOnSkip=false → 不询问,自然语言自动转图(v2.0 行为)
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...base, askOnSkip: false }, createStats(), mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 askOnSkip=false 自动转图不询问', /text2img/.test(txt(d.messages[0].content)) && askCount === 0)
  }
  // 9) 同一文本再次出现 → 指纹去重复用上次选择,不再问
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['转图摘要(推荐)'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    await markRunning(ctx)
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 同一文本不重复询问', askCount === 1)
    check('v2.1 重复文本复用上次选择(转图)', /text2img/.test(txt(d2.messages[0].content)) && /text2img/.test(txt(d1.messages[0].content)))
  }
  // 10) maxAsksPerSession 弹窗配额:首次询问,后续不同文本按内容类型默认静默执行
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['直接阅读原文'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true, maxAsksPerSession: 1 }, createStats(), mkDeps())
    await markRunning(ctx)
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const other = '另一段' + '完全不同的自然语言文本内容用于弹窗配额测试。'.repeat(15)
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(other))
    check('v2.1 弹窗配额:首次询问,后续静默默认(自然语言→转图)', askCount === 1 && d1.messages[0].content === nlText && /text2img/.test(txt(d2.messages[0].content)))
  }
  // 11) 运行时上下文快照(source.kind='plugin')不参与处理(乱触发事故回归:
  //     短指令 + 2864 字符 runtime-context 快照 → 弹窗指向快照)
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'text2img_path', selected: ['转图摘要(推荐)'] }] } })
    createText2imgModule(ctx, { ...base, askOnSkip: true }, createStats(), mkDeps())
    await markRunning(ctx)
    const runtime = {
      role: 'user',
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
      content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'.repeat(60),
    }
    const userMsg = { role: 'user', source: { kind: 'user', rpcId: 'x' }, content: nlText }
    const d = await ctx.emit('agent/pre-step', { signal: {} }, async () => ({ kind: 'enter', messages: [runtime, userMsg] }))
    check('v2.1 运行时上下文快照原样放行', d.messages[0].content === runtime.content)
    check('v2.1 快照不触发弹窗(仅用户消息弹一次)', askCount === 1 && /text2img/.test(txt(d.messages[1].content)))
  }
}

console.log('== text2img v2.1 摘要磁盘缓存(跨会话 0 API) ==')
{
  const cacheDir = mkdtempSync(join(tmpdir(), 't2i-cache-'))
  const nlText = '缓存测试' + '这是一段用于摘要磁盘缓存测试的自然语言长文本内容。'.repeat(15)
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false }

  // 1) 首次转换:渲染+摘要;二次转换:命中缓存,renderer 不再被调用
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[摘要] 磁盘缓存测试摘要。',
    }
    const ctx = makeFakeCtx()
    const stats = createStats()
    createText2imgModule(ctx, { ...base, summaryCache: true }, stats, { ...deps, cacheDir })
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 缓存首次转换渲染 1 次', renderCalls === 1)
    check('v2.1 缓存二次命中不重渲染', renderCalls === 1 && /text2img/.test(txt(d2.messages[0].content)))
    check('v2.1 缓存命中计数', stats.snapshot().counters['text2img.cacheHits'] === 1)
    check('v2.1 缓存命中标记', /摘要命中磁盘缓存/.test(txt(d2.messages[0].content)))
    check('v2.1 首次转换标记无缓存字样', !/摘要命中磁盘缓存/.test(txt(d1.messages[0].content)))
  }
  // 2) 跨"会话"(新模块实例,同一 cacheDir)→ 命中缓存,0 渲染 0 摘要
  {
    let renderCalls = 0
    let summarizeCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => { summarizeCalls += 1; return '[摘要] 不应被调用。' },
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true }, createStats(), { ...deps, cacheDir })
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 跨会话命中缓存 0 渲染 0 API', renderCalls === 0 && summarizeCalls === 0)
    check('v2.1 跨会话复用摘要', /磁盘缓存测试摘要/.test(txt(d.messages[0].content)))
  }
  // 3) 不同内容 → 未命中,正常渲染
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[摘要] 新内容摘要。',
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true }, createStats(), { ...deps, cacheDir })
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith('完全不同' + '的另一段自然语言文本内容用于缓存未命中测试。'.repeat(15)))
    check('v2.1 不同内容未命中正常渲染', renderCalls === 1)
  }
  // 4) 原文落盘去重:DSH 每 step 重发同一消息,缓存命中复用首次原文路径(事故:7 次出现 → 7 个重复文件)
  {
    const origDir = mkdtempSync(join(tmpdir(), 't2i-orig-'))
    const textDup = '原文去重' + '这是一段用于原文落盘去重测试的自然语言长文本内容。'.repeat(15)
    const depsD = {
      renderToPng: async () => '/tmp/fake.png',
      summarizeImage: async () => '[摘要] 原文去重测试。',
    }
    const ctx = makeFakeCtx()
    createText2imgModule(ctx, { ...base, summaryCache: true, saveOriginal: true }, createStats(), { ...depsD, cacheDir, originalDir: origDir })
    const d1 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(textDup))
    const d2 = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(textDup))
    const files = readdirSync(origDir)
    check('v2.1 缓存命中复用首次原文路径', files.length === 1 && txt(d2.messages[0].content).includes(files[0]) && /原始全文/.test(txt(d1.messages[0].content)))
  }
  // 5) 提示词变更 → 缓存作废(坏摘要被缓存复用会把事故永久化:知乎长文事故)
  {
    let renderCalls = 0
    const deps = {
      renderToPng: async () => { renderCalls += 1; return '/tmp/fake.png' },
      summarizeImage: async () => '[摘要] 新提示词摘要。',
    }
    const ctx = makeFakeCtx()
    // 同一文本 nlText 在测试 1 里已用默认提示词缓存;换提示词后必须走 vision
    createText2imgModule(ctx, { ...base, summaryCache: true, prompt: '完全不同的摘要提示词' }, createStats(), { ...deps, cacheDir })
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith(nlText))
    check('v2.1 提示词变更缓存作废', renderCalls === 1)
  }
}

console.log('== text2img v2.1 动态分辨率分档 ==')
{
  const base = { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false, summaryCache: false }
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  let lastPageConfig = null
  const deps = {
    renderToPng: async (text, pageConfig) => { lastPageConfig = pageConfig; return '/tmp/fake.png' },
    summarizeImage: async () => '[摘要] 分档测试。',
  }
  const ctx = makeFakeCtx()
  createText2imgModule(ctx, base, createStats(), deps)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('好'.repeat(1500)))
  check('v2.1 ≤2000 字 → 800×450', lastPageConfig.width === 800 && lastPageConfig.pageMaxHeight === 450 && lastPageConfig.pageFontSize === 24)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('好'.repeat(5000)))
  check('v2.1 ≤6000 字 → 1440×810', lastPageConfig.width === 1440 && lastPageConfig.pageMaxHeight === 810 && lastPageConfig.pageFontSize === 24)
  await ctx.emit('agent/pre-step', { signal: {} }, enterWith('好'.repeat(8000)))
  check('v2.1 >6000 字 → 1920×1080@36 号', lastPageConfig.width === 1920 && lastPageConfig.pageMaxHeight === 1080 && lastPageConfig.pageFontSize === 36)

  // dynamicResolution=false → 固定 renderWidth + 分页参数
  let lastPageConfig2 = null
  const deps2 = {
    renderToPng: async (text, pageConfig) => { lastPageConfig2 = pageConfig; return '/tmp/fake.png' },
    summarizeImage: async () => '[摘要] 分档测试。',
  }
  const ctx2 = makeFakeCtx()
  createText2imgModule(ctx2, { ...base, dynamicResolution: false, renderWidth: 900 }, createStats(), deps2)
  await ctx2.emit('agent/pre-step', { signal: {} }, enterWith('好'.repeat(8000)))
  check('v2.1 关闭动态分辨率用 renderWidth', lastPageConfig2.width === 900 && lastPageConfig2.pageMaxHeight === 3000)
}

console.log('== outputLadder ==')
{
  const cfg = resolveConfig({}).outputLadder
  const ctx = makeFakeCtx()
  const stats = createStats()
  createOutputLadderModule(ctx, cfg, stats)
  const mk = (text, isError = false) => ({ isError, content: [{ type: 'text', text }] })

  // 1) 错误结果 → 摘要
  const errText = 'Error: boom\n' + 'stack-line-padding-'.repeat(30)
  const dErr = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(errText, true), async () => ({ kind: 'accept' }))
  check('outputLadder 错误摘要标记', /错误输出已摘要/.test(txt(dErr.content)))
  check('outputLadder 错误摘要更短', txt(dErr.content).length < errText.length)
  check('outputLadder ladder.errors>=1', stats.snapshot().counters['ladder.errors'] >= 1)

  // 2) JSON 数组(>10k)→ 结构压缩
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 10 }))
  const bigJson = JSON.stringify(rows)
  const dJson = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(bigJson), async () => ({ kind: 'accept' }))
  check('outputLadder JSON 压缩标记', /json-array-compressed/.test(txt(dJson.content)))
  check('outputLadder JSON totalRows 500', /totalRows.:500/.test(txt(dJson.content)))
  check('outputLadder JSON 走 structured 分支', /outputLadder\.structured/.test(txt(dJson.content)))

  // 3) CSV → 结构压缩
  const csv = ['id,name', ...Array.from({ length: 2500 }, (_, i) => `${i},row-${i}`)].join('\n')
  const dCsv = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(csv), async () => ({ kind: 'accept' }))
  check('outputLadder CSV 省略标记', /行已省略/.test(txt(dCsv.content)))
  check('outputLadder CSV 表头保留', /id,name/.test(txt(dCsv.content)))

  // 4) pwsh 多行输出(无逗号表头,不应被当 CSV)→ shell 采样
  const shellLines = []
  for (let i = 1; i <= 500; i++) shellLines.push(`line-${i}: some content padding padding padding`)
  const shellText = shellLines.join('\n')
  const dShell = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(shellText), async () => ({ kind: 'accept' }))
  check('outputLadder shell 采样标记', /已采样展示头/.test(txt(dShell.content)))
  check('outputLadder shell 保留行号', /1\tline-1/.test(txt(dShell.content)))
  check('outputLadder shell 分支标记', /outputLadder\.shell/.test(txt(dShell.content)))

  // 5) read 类工具豁免
  const bigFile = 'file-content-'.repeat(3000)
  const dRead = await ctx.emit('tools/post-execute', { name: 'read' }, mk(bigFile), async () => ({ kind: 'accept' }))
  check('outputLadder read 豁免原样', dRead.content === undefined)

  // 6) >= spillBytes 字节的非结构化文本 → 放行交给核心 spill
  const huge = 'x'.repeat(55000)
  const dSpill = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(huge), async () => ({ kind: 'accept' }))
  check('outputLadder spill 区间放行', dSpill.content === undefined)
  check('outputLadder ladder.spillSkip>=1', stats.snapshot().counters['ladder.spillSkip'] >= 1)

  // 6b) >= spillBytes 字节的 JSON 数组 → 结构压缩优先(不交给 spill,信息密度更高)
  const bigRows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row-${i}`, payload: 'y'.repeat(40) }))
  const hugeJson = JSON.stringify(bigRows) // ~130k 字符
  const dHugeJson = await ctx.emit('tools/post-execute', { name: 'grep' }, mk(hugeJson), async () => ({ kind: 'accept' }))
  check('outputLadder 超大 JSON 走结构分支', /json-array-compressed/.test(txt(dHugeJson.content)))
  check('outputLadder 超大 JSON 不 spillSkip', /outputLadder\.structured/.test(txt(dHugeJson.content)))
  check('outputLadder 采样数封顶 500', /sampledRows.:500/.test(txt(dHugeJson.content)))

  // 7) 小输出/非 accept decision 原样
  const dSmall = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk('ok'), async () => ({ kind: 'accept' }))
  check('outputLadder 小输出原样', dSmall.content === undefined)
  const dReject = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(shellText), async () => ({ kind: 'reject' }))
  check('outputLadder 非 accept 不处理', dReject.kind === 'reject')

  // 8) pwsh 输出恰好是 JSON 数组 → 结构分支优先(决策表顺序)
  const dOrder = await ctx.emit('tools/post-execute', { name: 'pwsh' }, mk(bigJson), async () => ({ kind: 'accept' }))
  check('outputLadder pwsh-JSON 走 structured 分支', /outputLadder\.structured/.test(txt(dOrder.content)))
}

console.log('== compactionDriver ==')
{
  const tick = () => new Promise((r) => setTimeout(r, 20))
  const cfg = { ...resolveConfig({}).compactionDriver, minTurns: 6, minTokens: 100000, pressureRatio: 0.45, maxCompactionsPerSession: 3, timeoutMs: 1000 }
  const mkAgent = (turns, totalTokens) => {
    const events = []
    for (let i = 0; i < turns; i++) events.push({ type: 'turn/start' })
    events.push({ type: 'request/context', data: { contextWindow: 1000000 } })
    return { id: 'a1', session: { events } }
  }
  const mkServices = (compactNow, measure = () => ({ totalTokens: 500000 })) => ({ compactNow, measure })

  // 轮数/压力不足不触发
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } }, () => ({ totalTokens: 200000 }))
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    await ctx.emit('agent/status', { agent: mkAgent(2, 200000), status: 'idle' })
    await tick()
    check('compactionDriver 轮数不足不触发', calls === 0)
    await ctx.emit('agent/status', { agent: mkAgent(10, 200000), status: 'idle' })
    await tick()
    check('compactionDriver 压力不足不触发', calls === 0)
  }
  // 满足触发 + inFlight 防重入
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    check('compactionDriver 满足触发恰好一次', calls === 1)
    check('compactionDriver.completed=1', stats.snapshot().counters['compactionDriver.completed'] === 1)
  }
  // max 封顶
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    for (let i = 0; i < 5; i++) { await ctx.emit('agent/status', { agent, status: 'idle' }); await tick() }
    check('compactionDriver max 封顶(恰 3 次)', calls === 3)
  }
  // busy 回退后重试
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => {
      calls += 1
      if (calls === 1) { const e = new Error('busy'); e.code = 'busy'; throw e }
      return { tokenCount: 1 }
    })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    const c = stats.snapshot().counters
    check('compactionDriver busy 回退后重试成功', calls === 2 && c['compactionDriver.skippedBusy'] === 1 && c['compactionDriver.completed'] === 1)
  }
  // compactNow 返回 null(无可用区段)计次不崩
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return null })
    const stats = createStats()
    createCompactionDriverModule(ctx, cfg, stats)
    const agent = mkAgent(10, 500000)
    await ctx.emit('agent/status', { agent, status: 'idle' })
    await tick()
    check('compactionDriver null 结果计次不崩', calls === 1 && stats.snapshot().counters['compactionDriver.completed'] === undefined)
  }
  // 无服务:不触发、不抛(惰性获取,每次 idle 重试,只告警一次)
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => undefined
    createCompactionDriverModule(ctx, cfg, createStats())
    await ctx.emit('agent/status', { agent: mkAgent(10, 500000), status: 'idle' })
    await tick()
    check('compactionDriver 无服务不触发不抛', calls === 0)
  }
  // 空载荷/running 状态不抛
  {
    const ctx = makeFakeCtx()
    let calls = 0
    ctx.get = () => mkServices(async () => { calls += 1; return { tokenCount: 1 } })
    createCompactionDriverModule(ctx, cfg, createStats())
    await ctx.emit('agent/status', {})
    await ctx.emit('agent/status', { agent: mkAgent(10, 500000), status: 'running' })
    await tick()
    check('compactionDriver 空载荷/running 不触发', calls === 0)
  }
}

console.log('== cache ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  let executions = 0
  createCacheModule(ctx, resolveConfig({}).cache, stats)
  const exec = { name: 'glob', arguments: { pattern: '**/*.js' } }
  const run = async () => ctx.emit('tools/execute', exec, async () => {
    executions += 1
    return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'content' }] }
  })
  await run()
  await run()
  check('第二次命中缓存未执行', executions === 1)
  check('cache.hits=1', stats.snapshot().counters['cache.hits'] === 1)
}

console.log('== monitor ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  stats.bump('compress.tools', 3)
  stats.bump('compress.savedChars', 5000)
  createMonitorModule(ctx, { ...resolveConfig({}).monitor, showInChat: false }, stats)
  // session/disposed 应输出报告不抛错
  await ctx.emit('session/disposed', { id: 's1' })
  check('monitor 报告生成', stats.snapshot().counters['monitor.reports'] === 1)
}

console.log('== monitor usage 聚合与命中率 ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const logs = []
  const origLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  let report = ''
  try {
    createMonitorModule(ctx, { ...resolveConfig({}).monitor, showInChat: false }, stats)
    const session = { id: 's2' }
    await ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, reasoningTokens: 10 } } })
    await ctx.emit('session/event', session, { type: 'user/message', data: {} })
    await ctx.emit('session/event', session, { type: 'assistant/message', data: {} }) // 无 usage,不崩
    await ctx.emit('session/disposed', session)
    report = logs.join('\n')
  } finally {
    console.log = origLog
  }
  check('monitor 报告含命中率 90.0%', /缓存命中率: 90\.0%/.test(report))
  check('monitor 报告含用量行', /请求 1 次/.test(report))
  check('monitor 报告含推理行', /推理 token: 10/.test(report))
  const c = stats.snapshot().counters
  check('monitor usage 增量聚合', c['monitor.inputTokens'] === 100 && c['monitor.cacheReadTokens'] === 900 && c['monitor.usageEvents'] === 1)
}

console.log('== fileDiff ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  createFileDiffModule(ctx, resolveConfig({}).fileDiff, stats)
  const textA = 'line0\nline1\n' + 'padding-line-x\n'.repeat(500)
  const mk = (text) => ({ isError: false, content: [{ type: 'text', text }] })
  const d1 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff 首次读不改投影', d1.kind === 'accept' && d1.content === undefined)
  const d2 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff 未变化折叠', /未变化/.test(txt(d2.content)))
  const textB = textA.replace('line1', 'line1-CHANGED')
  const d3 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { path: 'a.txt' } }, mk(textB), async () => ({ kind: 'accept' }))
  check('fileDiff 变更发 diff', /变更/.test(txt(d3.content)) && /CHANGED/.test(txt(d3.content)))
  check('fileDiff 统计', stats.snapshot().counters['filediff.unchanged'] >= 1 && stats.snapshot().counters['filediff.changed'] >= 1)

  // 真实 read 工具的参数键是 file_path(pathOf 兼容)
  const d4 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'c.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  const d5 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'c.txt' } }, mk(textA), async () => ({ kind: 'accept' }))
  check('fileDiff file_path 键未变化折叠', /未变化/.test(txt(d5.content)))

  // 分段读取(offset/limit)不参与追踪/折叠:同一文件两个不同窗口不得被误判为"变更"
  const part1 = 'p'.repeat(3000)
  const part2 = 'q'.repeat(3000)
  const d6 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'd.txt', offset: 1, limit: 10 } }, mk(part1), async () => ({ kind: 'accept' }))
  const d7 = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'd.txt', offset: 11, limit: 10 } }, mk(part2), async () => ({ kind: 'accept' }))
  check('fileDiff 分段读取不追踪不折叠', d6.content === undefined && d7.content === undefined)
}

console.log('== toolTrim ==')
{
  let captured
  let restrictCalls = 0
  const ctxT = makeFakeCtx()
  const statsT = createStats()
  const fakeAgent = {
    id: 'a1',
    ctx: {
      tools: {
        restrict: (filter) => { captured = filter; restrictCalls += 1; return () => {} },
      },
    },
  }
  createToolTrimModule(ctxT, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'], deny: ['write'] }, statsT)
  await ctxT.emit('agent/created', { agent: fakeAgent })
  check('toolTrim 对 agent 作用域调用 restrict', captured && captured.allow[0] === 'read' && captured.deny[0] === 'write')
  check('toolTrim 计数', statsT.snapshot().counters['tooltrim.applied'] === 1)
  await ctxT.emit('agent/created', { agent: fakeAgent })
  check('toolTrim 同 agent 不重复 restrict', restrictCalls === 1)
  // 关闭时不注册监听
  let registered = false
  const ctxD = makeFakeCtx()
  ctxD.on = (event) => { registered = event === 'agent/created' }
  createToolTrimModule(ctxD, { ...resolveConfig({}).toolTrim, enabled: false, allow: ['read'] }, createStats())
  check('toolTrim 关闭不注册监听', registered === false)
  // 单个 agent restrict 失败(如未知工具名)不抛,后续 agent 不受影响
  const ctxTh = makeFakeCtx()
  let okCalls = 0
  createToolTrimModule(ctxTh, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'] }, createStats())
  await ctxTh.emit('agent/created', { agent: { id: 'bad', ctx: { tools: { restrict: () => { throw new Error('names unknown global tool') } } } } })
  await ctxTh.emit('agent/created', { agent: { id: 'good', ctx: { tools: { restrict: () => { okCalls += 1; return () => {} } } } } })
  check('toolTrim 单个失败不影响后续', okCalls === 1)
  // 无 agent.ctx 的载荷不抛
  await ctxTh.emit('agent/created', {})
  check('toolTrim 空载荷不抛', true)
}

console.log('== toolGate mcpLazy ==')
{
  const identityDefineTool = (o) => o
  const tick = () => new Promise((r) => setTimeout(r, 10))

  // 1) 检测到 mcp 工具 → 注册元工具 + deny 全量拦截
  {
    const ctx = makeFakeCtx()
    const stats = createStats()
    const restricted = []
    const registered = []
    const disposers = []
    const mkDisposer = (i) => { let called = 0; disposers.push({ called: () => called, call: () => { called += 1 } }); return disposers[disposers.length - 1] }
    const tools = {
      view: () => ({
        restrictableNames: new Set(['read', 'write', 'mcp__srv__a', 'mcp__srv__b']),
        visible: new Map([
          ['mcp__srv__a', { description: 'analyze tool A' }],
          ['mcp__srv__b', { description: 'analyze tool B' }],
        ]),
      }),
      restrict: (filter) => { restricted.push(filter); const d = mkDisposer(); return () => d.call() },
      register: (def) => { registered.push(def); return () => {} },
    }
    createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, allow: [], deny: [], mcpLazy: true }, stats, { defineTool: identityDefineTool })
    await ctx.emit('agent/created', { agent: { id: 'm1', ctx: { tools } } })
    await tick()
    check('toolGate 检测 mcp 注册元工具', registered.length === 1 && registered[0].name === 'mcp_load_tools')
    check('toolGate 索引含工具描述', /mcp__srv__a: analyze tool A/.test(registered[0].description))
    check('toolGate 初始 deny 全量 mcp', restricted.length === 1 && restricted[0].deny.includes('mcp__srv__a') && restricted[0].deny.includes('mcp__srv__b'))
    check('toolGate mcpDetected 计数', stats.snapshot().counters['toolgate.mcpDetected'] === 1)

    // 2) 放行一个 → 旧 disposer 被调 + 重挂 filter 只剩 b
    const meta = registered[0]
    const out = await meta.execute({ names: ['mcp__srv__a'] }, { agent: { id: 'm1' } })
    await tick()
    check('toolGate 放行后旧 restrict 被撤', disposers[0].called() === 1)
    check('toolGate 重挂 deny 只剩 b', restricted.length === 2 && !restricted[1].deny.includes('mcp__srv__a') && restricted[1].deny.includes('mcp__srv__b'))
    check('toolGate 放行返回文案', /已放行: mcp__srv__a/.test(out))
    check('toolGate mcpReleased 计数', stats.snapshot().counters['toolgate.mcpReleased'] === 1)

    // 3) 未知名 → 不触发重挂
    const before = restricted.length
    const out2 = await meta.execute({ names: ['mcp__nope'] }, { agent: { id: 'm1' } })
    check('toolGate 未知名不重挂', restricted.length === before && /未知或不可放行: mcp__nope/.test(out2))
  }

  // 4) 无 mcp 工具 → no-op(不注册元工具),静态 allow 仍生效
  {
    const ctx = makeFakeCtx()
    const restricted = []
    const registered = []
    const tools = {
      view: () => ({ restrictableNames: new Set(['read', 'write']), visible: new Map() }),
      restrict: (filter) => { restricted.push(filter); return () => {} },
      register: () => { registered.push(1); return () => {} },
    }
    createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'], deny: [], mcpLazy: true }, createStats(), { defineTool: identityDefineTool })
    await ctx.emit('agent/created', { agent: { id: 'm2', ctx: { tools } } })
    await tick()
    check('toolGate 无 mcp 不注册元工具', registered.length === 0)
    check('toolGate 静态 allow 仍挂载', restricted.length === 1 && restricted[0].allow.includes('read'))
  }

  // 5) restrict 抛错 → warn 不崩,元工具仍在
  {
    const ctx = makeFakeCtx()
    const registered = []
    const tools = {
      view: () => ({ restrictableNames: new Set(['mcp__srv__a']), visible: new Map([['mcp__srv__a', { description: 'd' }]]) }),
      restrict: () => { throw new Error('names unknown global tool') },
      register: (def) => { registered.push(def); return () => {} },
    }
    createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, allow: [], deny: [], mcpLazy: true }, createStats(), { defineTool: identityDefineTool })
    await ctx.emit('agent/created', { agent: { id: 'm3', ctx: { tools } } })
    await tick()
    check('toolGate restrict 抛错元工具仍注册', registered.length === 1)
  }

  // 6) 静态 allow + mcp 放行合并
  {
    const ctx = makeFakeCtx()
    const restricted = []
    const registered = []
    const tools = {
      view: () => ({ restrictableNames: new Set(['read', 'mcp__srv__a']), visible: new Map([['mcp__srv__a', { description: 'd' }]]) }),
      restrict: (filter) => { restricted.push(filter); return () => {} },
      register: (def) => { registered.push(def); return () => {} },
    }
    createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, allow: ['read'], deny: [], mcpLazy: true }, createStats(), { defineTool: identityDefineTool })
    await ctx.emit('agent/created', { agent: { id: 'm4', ctx: { tools } } })
    await tick()
    await registered[0].execute({ names: ['mcp__srv__a'] }, { agent: { id: 'm4' } })
    await tick()
    check('toolGate 静态 allow 与放行合并', restricted.length === 2 && restricted[1].allow.includes('read') && restricted[1].allow.includes('mcp__srv__a'))
  }

  // 7) 死循环回归:restrict 触发 tools/change → 无真实变化时不得重挂
  // (事故:tools/change → 重挂 → restrict → tools/change 循环到 harness OOM)
  {
    const ctx = makeFakeCtx()
    const restricted = []
    const tools = {
      view: () => ({ restrictableNames: new Set(['mcp__srv__a']), visible: new Map([['mcp__srv__a', { description: 'd' }]]) }),
      restrict: (filter) => { restricted.push(filter); return () => {} },
      register: () => () => {},
    }
    createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, allow: [], deny: [], mcpLazy: true }, createStats(), { defineTool: identityDefineTool })
    await ctx.emit('agent/created', { agent: { id: 'm5', ctx: { tools } } })
    await tick()
    const afterCreated = restricted.length
    for (let i = 0; i < 20; i++) await ctx.emit('tools/change')
    await tick()
    check('toolGate tools/change 无变化不重挂(防死循环)', restricted.length === afterCreated)
  }
}

console.log('')
if (failures === 0) {
  console.log('ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
