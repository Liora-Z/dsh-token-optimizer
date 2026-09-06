// text2img 真实端到端验证(需 DEEPSEEK_API_KEY 环境变量,会消耗少量 API 额度)
// 用法: node test/text2img-e2e.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createText2imgModule } from '../src/modules/text2img.js'

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

// 生成 6000+ 字符自然语言文本(超过默认阈值 5000)
let text = ''
for (let i = 1; i <= 60; i++) {
  text += `第 ${i} 段:这是一段用于端到端验证长文本转图片功能的自然语言内容。`
  text += `我们在测试 DeepSeek 视觉模型能否准确阅读渲染图片中的中文文字。`
  text += `关键数字标记:段号 ${i}。结束。\n`
}
console.log(`测试文本长度: ${text.length} 字符`)

const ctx = makeFakeCtx()
const stats = createStats()
const cfg = resolveConfig({})
createText2imgModule(ctx, cfg.text2img, stats)

const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: text }] })
console.log('触发 agent/pre-step...')
const decision = await ctx.emit('agent/pre-step', { signal: {} }, next)

const replaced = decision.messages[0].content
console.log('--- 替换后内容(前 400 字符) ---')
console.log(replaced.slice(0, 400))
console.log('---')
const saved = text.length - replaced.length
console.log(`原始: ${text.length} 字符 → 替换后: ${replaced.length} 字符 → 节省: ${saved} 字符 (${(saved / text.length * 100).toFixed(1)}%)`)
console.log(`统计: ${JSON.stringify(stats.snapshot().counters)}`)
