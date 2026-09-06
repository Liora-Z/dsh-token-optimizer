// 监控(monitor):会话结束(session/disposed)时输出本次会话的 token 节省统计。
//
// 数据来源:stats 计数器的 snapshot(各模块累加的 savedChars/次数)+
// 可选 ctx.tokenMeter(DSH 内置计量,存在时取 measure 数据)。
// v2 新增:监听 session/event 聚合 assistant/message 的 data.usage,期末报告
// 真实模型用量与缓存命中率(DeepSeek 磁盘前缀缓存,cacheReadTokens 即命中部分,
// 命中率 = cacheRead / (input + cacheRead);inputTokens 按 API 惯例不含缓存读)。
// 输出方式:console 日志(DSH 进程可见);showInChat 时通过会话追加一条消息。

// usage 键名兼容:snake_case / cached_tokens 等变体都取首个有值者
function pickUsageField(u, ...names) {
  for (const name of names) {
    const v = u?.[name]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

export function createMonitorModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  // per-session usage 聚合(session/event 的 assistant/message 事件带 data.usage)
  const usageBySession = new Map()

  const onSessionEvent = (session, event) => {
    if (event?.type !== 'assistant/message') return
    const u = event?.data?.usage
    if (!u || typeof u !== 'object') return
    let agg = usageBySession.get(session)
    if (!agg) {
      agg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, events: 0 }
      usageBySession.set(session, agg)
    }
    const dIn = pickUsageField(u, 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
    const dOut = pickUsageField(u, 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
    const dCache = pickUsageField(u, 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'promptCacheHitTokens', 'prompt_cache_hit_tokens')
    const dReason = pickUsageField(u, 'reasoningTokens', 'reasoning_tokens')
    agg.inputTokens += dIn
    agg.outputTokens += dOut
    agg.cacheReadTokens += dCache
    agg.reasoningTokens += dReason
    agg.events += 1
    // 注意:bump 是加法,传单事件增量而非累计值
    stats?.bump('monitor.usageEvents', 1)
    stats?.bump('monitor.inputTokens', dIn)
    stats?.bump('monitor.outputTokens', dOut)
    stats?.bump('monitor.cacheReadTokens', dCache)
    stats?.bump('monitor.reasoningTokens', dReason)
  }

  const handler = async (session) => {
    const snapshot = stats.snapshot()
    const lines = ['── dsh-token-optimizer 会话统计 ──']
    for (const [key, value] of Object.entries(snapshot.counters)) {
      lines.push(`  ${key}: ${value}`)
    }
    const totalChars = snapshot.samples.reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
    if (totalChars > 0) lines.push(`  共节省约 ${totalChars.toLocaleString()} 字符(压缩/去重/采样/摘要)`)

    // v2:模型真实用量与缓存命中率(会话内聚合的 usage)
    const agg = usageBySession.get(session)
    if (agg && agg.events > 0) {
      const totalInput = agg.inputTokens + agg.cacheReadTokens
      const hitRate = totalInput > 0 ? `${((agg.cacheReadTokens / totalInput) * 100).toFixed(1)}%` : 'n/a'
      lines.push(`  模型 usage: 请求 ${agg.events} 次, 输入 ${agg.inputTokens.toLocaleString()} / 缓存命中 ${agg.cacheReadTokens.toLocaleString()} / 输出 ${agg.outputTokens.toLocaleString()} token`)
      lines.push(`  缓存命中率: ${hitRate}(= 缓存命中 / (输入 + 缓存命中))`)
      if (agg.reasoningTokens > 0) lines.push(`  推理 token: ${agg.reasoningTokens.toLocaleString()}`)
    }

    // 尝试读取内置 token meter 数据(存在时)
    let meterLine = ''
    try {
      if (ctx.tokenMeter && typeof ctx.tokenMeter.measure === 'function') {
        const m = await ctx.tokenMeter.measure(session)
        if (m && typeof m.totalTokens === 'number') {
          meterLine = `  上下文 surfaceTokens: ${m.surfaceTokens ?? '?'} / totalTokens: ${m.totalTokens}`
          lines.push(meterLine)
        }
      }
    } catch {
      // tokenMeter 不可用或失败:静默跳过
    }

    const report = lines.join('\n')
    console.log(report)

    // showInChat:以用户消息形式追加到会话(轻量,失败不致命)
    if (config.showInChat && session && typeof session.append === 'function') {
      try {
        session.append('user', {
          content: [{ type: 'text', text: report }],
          source: { kind: 'plugin', plugin: 'dsh-token-optimizer' },
        })
      } catch {
        // 追加失败不致命
      }
    }
    stats?.bump('monitor.reports', 1)
    usageBySession.delete(session)
  }

  ctx.on('session/disposed', handler)
  listeners.push(() => ctx.off('session/disposed', handler))
  ctx.on('session/event', onSessionEvent)
  listeners.push(() => ctx.off('session/event', onSessionEvent))
  return () => {
    usageBySession.clear()
    for (const off of listeners) off()
  }
}
