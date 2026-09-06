// 核心逻辑单元测试(node --test)。
// 直接调用模块内部压缩/指纹函数,不依赖 DSH 运行时。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createOutputLadderModule } from '../src/modules/outputLadder.js'
import { createCacheModule } from '../src/modules/cache.js'

// 内容可能是 string 或 [{type:'text',text}] 数组,断言前统一抽取文本
function txt(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

// ---- 模拟最小 DSH ctx:只实现 on/off 记录 + 事件派发 ----
function makeFakeCtx() {
  const handlers = new Map()
  return {
    on(event, handler) {
      handlers.set(event, handler)
    },
    off(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event)
    },
    async emit(event, ...args) {
      const h = handlers.get(event)
      if (!h) throw new Error(`no handler for ${event}`)
      return h(...args)
    },
  }
}

test('resolveConfig 默认值与校验', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.outputLadder.structureThreshold, 10000)
  assert.equal(cfg.cache.ttl, 3600)
  assert.equal(cfg.compactionDriver.pressureRatio, 0.45)
  assert.throws(() => resolveConfig({ outputLadder: { bogus: 1 } }), /unknown key/)
  assert.throws(() => resolveConfig({ outputLadder: { structureThreshold: -5 } }), /must be a number/)
  // v1 退役节静默忽略不抛(防炸插件树)
  assert.doesNotThrow(() => resolveConfig({ compress: { threshold: 1 }, dedup: {}, pruning: {}, sample: {} }))
})

test('outputLadder: 大 JSON 数组被采样压缩,小输出不动', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  createOutputLadderModule(ctx, resolveConfig({}).outputLadder, stats)

  // 构造 500 行 JSON 数组
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 10 }))
  const bigText = JSON.stringify(rows)

  const result = { isError: false, value: rows, content: [{ type: 'text', text: bigText }] }
  const decision = await ctx.emit('tools/post-execute', { name: 'grep' }, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.notEqual(decision.content[0].text, bigText)
  assert.match(decision.content[0].text, /json-array-compressed/)
  assert.match(decision.content[0].text, /totalRows.:500/)
  assert.ok(decision.content[0].text.length < bigText.length)
  assert.ok(stats.snapshot().counters['ladder.structured'] >= 1)

  // 小输出不压缩
  const small = { isError: false, value: [1, 2, 3], content: [{ type: 'text', text: '[1,2,3]' }] }
  const d2 = await ctx.emit('tools/post-execute', { name: 'grep' }, small, async () => ({ kind: 'accept' }))
  assert.equal(d2.kind, 'accept')
  assert.equal(d2.content, undefined)
  assert.equal(small.content[0].text, '[1,2,3]')
})

test('outputLadder: CSV 头尾保留', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  // 100 行 CSV 约 1.2KB,低于默认阈值 10000 不会触发;调低阈值与头尾保留行数
  createOutputLadderModule(ctx, { ...resolveConfig({}).outputLadder, structureThreshold: 500, preserveHeadTail: 5 }, stats)
  const csv = ['id,name', ...Array.from({ length: 100 }, (_, i) => `${i},row-${i}`)].join('\n')
  const result = { isError: false, value: csv, content: [{ type: 'text', text: csv }] }
  const decision = await ctx.emit('tools/post-execute', { name: 'grep' }, result, async () => ({ kind: 'accept' }))
  assert.match(decision.content[0].text, /行已省略/)
  assert.match(decision.content[0].text, /id,name/) // 表头保留
})

test('cache: 命中短路,未命中执行', async () => {
  const ctx = makeFakeCtx()
  const stats = createStats()
  let executions = 0
  createCacheModule(ctx, resolveConfig({}).cache, stats)

  const exec = { name: 'glob', arguments: { pattern: '**/*.js' } }
  const run = async () => {
    const result = await ctx.emit('tools/execute', exec, async () => {
      executions += 1
      return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'content' }] }
    })
    return result
  }
  await run()
  await run()
  assert.equal(executions, 1) // 第二次命中缓存,未执行
  assert.equal(stats.snapshot().counters['cache.hits'], 1)
})
