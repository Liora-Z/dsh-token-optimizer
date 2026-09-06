// dsh-token-optimizer: 分层 Token 优化管道(v2)
//
// 真实 DSH 插件 API 说明(与原始方案文档的虚构事件不同):
//   - 插件是 Cordis 插件,入口 export function apply(ctx, config = {})
//   - ctx.on('agent/pre-step', (payload, next) => ...)  改写进入模型的消息(inbox 批次)
//   - ctx.on('tools/execute') / ctx.on('tools/post-execute')  工具执行/结果替换(出生点)
//   - ctx.on('session/disposed')  会话结束
//   - ctx.on('agent/status' | 'agent/created' | 'agent/disposed' | 'session/event' | 'tools/change')
//   - ctx.compaction(compactNow)/ctx.tokenMeter(measure)  经 ctx.get 访问(未声明 inject)
//
// 本插件不重复实现 DSH 已内置的能力:
//   - token-meter(计量/投影)、compaction-basic(LLM 摘要压缩,可逆)、
//     tool-result-pruner(8192 字符,仅压缩触发)、spill(>50k 字节落盘可检索)
//
// v2 模块清单:
//   1. text2img  长文本→图片→vision 摘要(超长自然语言文本,实测省 ~72%)
//   2. outputLadder  工具输出出生点单次遍历分流(合并 v1 的 compress/sample/pruning
//      截断意图):错误摘要 / JSON-CSV 结构压缩 / shell 采样,原文落盘可逆
//   3. cache     结果缓存(相同工具调用 TTL 内短路复用)
//   4. monitor   会话结束统计报告(v2 新增真实 usage 聚合与缓存命中率)
//   5. fileDiff  重复读文件→增量 diff(跨调用记哈希,未变折叠/变更只发 diff)
//   6. toolTrim  工具可见性管理:静态 allow/deny 裁剪 + v2 新增 mcpLazy
//      (mcp__* 默认全拦截,mcp_load_tools 元工具按名放行,无 MCP 部署自动 no-op)
//   7. compactionDriver  压缩调度器:agent idle 时按自定义压力比(默认 45%)驱动
//      核心 ctx.compaction.compactNow(核心 0.8 阈值对 1M 窗口永不触发)
//
// v1 的 compress/sample/pruning/dedup 已退役(dedup 作用面趋零;其余合并进
// outputLadder;旧配置节会被静默忽略并提示,不会炸插件树)。

import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { createText2imgModule } from './modules/text2img.js'
import { createOutputLadderModule } from './modules/outputLadder.js'
import { createCacheModule } from './modules/cache.js'
import { createMonitorModule } from './modules/monitor.js'
import { createFileDiffModule } from './modules/fileDiff.js'
import { createToolTrimModule } from './modules/toolTrim.js'
import { createCompactionDriverModule } from './modules/compactionDriver.js'
import { createStats } from './stats.js'
import { appendFileSync } from 'node:fs'

// 调试日志:默认关闭,需要排查时设 DSH_TOKEN_OPTIMIZER_DEBUG=1 才写盘
const DEBUG_LOG = !!process.env.DSH_TOKEN_OPTIMIZER_DEBUG
function debugLog(msg) {
  if (!DEBUG_LOG) return
  try {
    appendFileSync('D:\\dsh\\token-optimizer-debug.log', `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* 忽略日志失败 */ }
}

debugLog('module loaded, apply defined: ' + typeof apply)

export function apply(ctx, config = {}) {
  debugLog('apply() CALLED with config keys: ' + (Object.keys(config ?? {}).join(',') || '(empty)'))
  const resolved = resolveConfig(config)
  const stats = createStats()

  const modules = []
  if (resolved.text2img.enabled) modules.push(createText2imgModule(ctx, resolved.text2img, stats))
  if (resolved.outputLadder.enabled) modules.push(createOutputLadderModule(ctx, resolved.outputLadder, stats))
  if (resolved.cache.enabled) modules.push(createCacheModule(ctx, resolved.cache, stats))
  if (resolved.monitor.enabled) modules.push(createMonitorModule(ctx, resolved.monitor, stats))
  if (resolved.fileDiff.enabled) modules.push(createFileDiffModule(ctx, resolved.fileDiff, stats))
  if (resolved.toolTrim.enabled) modules.push(createToolTrimModule(ctx, resolved.toolTrim, stats))
  if (resolved.compactionDriver.enabled) modules.push(createCompactionDriverModule(ctx, resolved.compactionDriver, stats))
  // 插件卸载时清理所有注册的钩子
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }
