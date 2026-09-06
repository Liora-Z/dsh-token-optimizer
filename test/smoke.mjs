// 单进程 smoke 验证(替代 node --test,规避沙箱 spawn EPERM)。
// 用法: node test/smoke.mjs

import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createText2imgModule } from '../src/modules/text2img.js'
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
  let threw = false
  try { resolveConfig({ outputLadder: { bogus: 1 } }) } catch { threw = true }
  check('未知键报错', threw)
  threw = false
  try { resolveConfig({ outputLadder: { structureThreshold: -5 } }) } catch { threw = true }
  check('负数报错', threw)
  // v1 退役节静默忽略不抛
  let legacyThrew = false
  try { resolveConfig({ compress: { threshold: 1 }, pruning: {}, dedup: {}, sample: {} }) } catch { legacyThrew = true }
  check('退役节静默忽略不抛', !legacyThrew)
}

console.log('== text2img 完整流程(mock 渲染+摘要) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  // mock:渲染返回假路径,摘要返回固定文本
  const deps = {
    renderToPng: async (text) => '/tmp/fake.png',
    summarizeImage: async (png, cfg) => `[摘要] 共 ${Math.floor(png.length)} 字节图片,内容摘要:这是一段测试文本的简要概括。`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false }, stats, deps)
  const longText = '这是' + '一段很长很长很长很长很长很长很长很长的自然语言文本内容,用于测试摘要替换。'.repeat(10)
  const nextLong = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dLong = await ctx.emit('agent/pre-step', { signal: {} }, nextLong)
  check('长自然语言文本触发 text2img', /text2img/.test(txt(dLong.messages[0].content)))
  check('text2img 内容包含摘要', /\[摘要\]/.test(txt(dLong.messages[0].content)))
  check('text2img 替换后更短', txt(dLong.messages[0].content).length < longText.length)
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
  createText2imgModule(ctx2, { ...resolveConfig({}).text2img, threshold: 100 }, stats2, depsFail)
  const nextFail = async () => ({ kind: 'enter', messages: [{ role: 'user', content: longText }] })
  const dFail = await ctx2.emit('agent/pre-step', { signal: {} }, nextFail)
  check('渲染失败保留原文', dFail.messages[0].content === longText)
  check('text2img.failures=1', stats2.snapshot().counters['text2img.failures'] === 1)
}

// 多页渲染:renderer 返回路径数组,应全部送入摘要
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => ['/tmp/fake-p1.png', '/tmp/fake-p2.png'],
    summarizeImage: async (pngs) => `[摘要] 共 ${pngs.length} 页图片`,
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false }, stats, deps)
  const multiText = '多页测试' + '这是一段用于多页渲染测试的长文本内容。'.repeat(20)
  const nextMulti = async () => ({ kind: 'enter', messages: [{ role: 'user', content: multiText }] })
  const dMulti = await ctx.emit('agent/pre-step', { signal: {} }, nextMulti)
  check('多页渲染触发 text2img', /text2img/.test(txt(dMulti.messages[0].content)))
  check('多页摘要包含页数', /共 2 页/.test(txt(dMulti.messages[0].content)))
  check('多页统计计数', stats.snapshot().counters['text2img.messages'] === 1)
}

console.log('== text2img 结构过滤(v2 精化) ==')
{
  const ctx = makeFakeCtx()
  const stats = createStats()
  const deps = {
    renderToPng: async () => '/tmp/fake.png',
    summarizeImage: async () => '[摘要] 测试摘要。',
  }
  createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false }, stats, deps)
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

console.log('== text2img 强制转图询问(askOnSkip) ==')
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
    summarizeImage: async () => '[摘要] 强制转图后的摘要内容。',
  })
  const structural = ['----------------', '================', '+----+----+', '----------------', '**********', ...Array.from({ length: 250 }, (_, i) => `这是第 ${i} 行正文内容,用于测试结构强度过滤。`)].join('\n')
  const enterWith = (text) => async () => ({ kind: 'enter', messages: [{ content: text }] })
  const markRunning = (ctx) => ctx.emit('agent/status', { agent: { id: 'root1' }, status: 'running' })

  // 1) 用户选"强制转图" → 走渲染;ask 请求必须带 agent(web provider 强制)
  {
    let askCount = 0
    let askGotAgent = false
    const ctx = mkCtxWithAsk(async (req) => { askCount += 1; askGotAgent = !!req?.agent; return { answers: [{ id: 'force_text2img', selected: ['yes'] }] } })
    const stats = createStats()
    createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('askOnSkip 选是→强制转图', /text2img/.test(txt(d.messages[0].content)))
    check('text2img.forced 计数', stats.snapshot().counters['text2img.forced'] === 1)
    check('ask 被调用一次且带 agent', askCount === 1 && askGotAgent)
  }
  // 2) 用户选"不转图" → 原文保留
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [{ id: 'force_text2img', selected: ['no'] }] } })
    const stats = createStats()
    createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('askOnSkip 选否→原文保留', d.messages[0].content === structural)
    check('text2img.skipped 计数', stats.snapshot().counters['text2img.skipped'] === 1)
    // 3) 同一文本再次出现 → 指纹去重,不再问
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('同一文本不重复询问', askCount === 1)
  }
  // 4) ask 抛错(NO_PROVIDER 等)→ 降级不转图不崩
  {
    const ctx = mkCtxWithAsk(async () => { throw new Error('NO_PROVIDER') })
    const stats = createStats()
    createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: true }, stats, mkDeps())
    await markRunning(ctx)
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('ask 抛错降级为不转图', d.messages[0].content === structural)
  }
  // 4b) 没有 running 事件(拿不到当前 agent)→ 不询问直接跳过
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: true }, createStats(), mkDeps())
    const d = await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('无当前 agent 不询问直接跳过', d.messages[0].content === structural && askCount === 0)
  }
  // 5) askOnSkip=false → 不询问直接跳过
  {
    let askCount = 0
    const ctx = mkCtxWithAsk(async () => { askCount += 1; return { answers: [] } })
    createText2imgModule(ctx, { ...resolveConfig({}).text2img, threshold: 100, saveOriginal: false, askOnSkip: false }, createStats(), mkDeps())
    await markRunning(ctx)
    await ctx.emit('agent/pre-step', { signal: {} }, enterWith(structural))
    check('askOnSkip=false 不询问', askCount === 0)
  }
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
