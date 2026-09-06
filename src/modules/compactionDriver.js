// 压缩调度器(compactionDriver):在核心 compaction-basic 的触发条件之外,
// 增加自定义触发源,让长会话的压缩"真正发生"。
//
// 为什么需要:核心只在 totalTokens >= 0.8 × contextWindow 时自动压缩;
// 对 1M 窗口的模型,这个阈值在普通会话里永远够不着(实测峰值 490k 也未触发),
// 上下文只涨不缩。本模块在 agent 空闲时按自定义压力比(默认 45%)主动调
// ctx.compaction.compactNow(与 /compact 命令同一路径,要求 agent idle,
// 摘要替换历史区间,原文留在 append-only 日志,可逆)。
//
// 触发状态机(per-agent):
//   agent/status(idle) → 同步检查 minTurns / maxCompactionsPerSession /
//   minTokens / pressureRatio 四重闸 → setImmediate 异步执行(让 idle 事件
//   派发栈先退栈,避免在派发栈内进入 runMaintenance)。
// 失败分类:
//   busy/cancelled(ManualCompactionError)→ 回退计数,下次 idle 重试
//   其余 → failed 计数,不重试(仍受 max 封顶)

export function createCompactionDriverModule(ctx, config, stats) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  // cordis 服务获取:ctx.get 在未声明 inject 时会抛"cannot get without inject"
  // (真实事故:被 catch 吞掉后永远拿不到服务)。正解 = ctx.inject(behaviorPrompt
  // 同款模式,服务可用时回调执行,晚激活也没关系)。保留 ctx.get 兜底供 smoke
  // 测试与非常规 ctx 使用。
  let compaction
  let tokenMeter
  let servicesWarned = false
  let servicesReadyLogged = false

  try {
    ctx.inject?.(['compaction', 'tokenMeter'], (sctx) => {
      if (!compaction) compaction = sctx.compaction
      if (!tokenMeter) tokenMeter = sctx.tokenMeter
      const ok = !!compaction && typeof compaction.compactNow === 'function' && !!tokenMeter && typeof tokenMeter.measure === 'function'
      if (ok && !servicesReadyLogged) {
        servicesReadyLogged = true
        console.log('[dsh-token-optimizer] compactionDriver 服务就绪(compaction + tokenMeter 已取得),触发判定生效')
      }
    })
  } catch (err) {
    console.warn('[dsh-token-optimizer] compactionDriver inject 注册失败: ' + (err?.message ?? err))
  }

  function ensureServices(agent) {
    if (compaction && typeof compaction.compactNow === 'function' && tokenMeter && typeof tokenMeter.measure === 'function') return true
    try {
      if (typeof ctx.get === 'function') {
        if (!compaction) compaction = ctx.get('compaction')
        if (!tokenMeter) tokenMeter = ctx.get('tokenMeter')
      }
    } catch (err) {
      console.warn('[dsh-token-optimizer] compactionDriver ctx.get 抛错: ' + (err?.message ?? err))
    }
    const ok = !!compaction && typeof compaction.compactNow === 'function' && !!tokenMeter && typeof tokenMeter.measure === 'function'
    if (ok && !servicesReadyLogged) {
      servicesReadyLogged = true
      console.log('[dsh-token-optimizer] compactionDriver 服务就绪(compaction + tokenMeter 已取得),触发判定生效')
    } else if (!ok && !servicesWarned) {
      servicesWarned = true
      console.warn('[dsh-token-optimizer] compactionDriver 尚未取得 compaction/tokenMeter 服务,将在每次 agent idle 时重试(注意:web 部署需在 profile cordis.patch.yml 重新启用被 dsh-web-app 禁用的 compaction-basic 行)')
    }
    return ok
  }

  const listeners = []
  const states = new Map() // agentId -> { inFlight, compactionsDone }
  let warnedNoEvents = false

  function turnCountOf(session) {
    const events = session?.events
    if (!Array.isArray(events)) {
      if (!warnedNoEvents) {
        warnedNoEvents = true
        console.warn('[dsh-token-optimizer] compactionDriver 无法读取 session.events,触发判断不可用(探针阶段请核对会话对象形状)')
      }
      return 0
    }
    let n = 0
    for (const e of events) if (e?.type === 'turn/start') n += 1
    return n
  }

  // 上下文窗口:优先读会话日志里最新的 request/context 事件(真实窗口),否则用配置
  function contextWindowOf(session, fallback) {
    const events = session?.events
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e?.type === 'request/context' && typeof e?.data?.contextWindow === 'number') return e.data.contextWindow
      }
    }
    return fallback
  }

  async function runCompaction(agent, state) {
    const signal = AbortSignal.timeout(config.timeoutMs)
    try {
      stats?.bump('compactionDriver.triggers', 1)
      const result = await compaction.compactNow(agent, signal)
      if (result === null) {
        // 无可用压缩区段:计为已用次数,不立即重试(防每轮空转),由 max 封顶
        return
      }
      stats?.bump('compactionDriver.completed', 1)
      console.log(`[dsh-token-optimizer] compactionDriver 压缩完成:agent "${agent?.id ?? '?'}" 历史已替换为摘要(原文可回放)`)
    } catch (err) {
      const code = err?.code
      if (code === 'busy' || code === 'cancelled') {
        // 与用户手动 /compact 并发(busy)或本插件超时/中止(cancelled):
        // 回退计数,下次 idle 重试
        stats?.bump('compactionDriver.skippedBusy', 1)
        state.compactionsDone = Math.max(0, state.compactionsDone - 1)
      } else {
        stats?.bump('compactionDriver.failed', 1)
        console.warn(`[dsh-token-optimizer] compactionDriver 压缩失败:${err?.message ?? err}`)
      }
    } finally {
      state.inFlight = false
    }
  }

  const onStatus = (payload) => {
    const agent = payload?.agent
    if (!agent || payload?.status !== 'idle') return
    if (!ensureServices(agent)) return
    const session = agent.session
    if (!session) return

    let state = states.get(agent.id)
    if (!state) {
      state = { inFlight: false, compactionsDone: 0 }
      states.set(agent.id, state)
    }
    if (state.inFlight) return
    if (state.compactionsDone >= config.maxCompactionsPerSession) return
    if (turnCountOf(session) < config.minTurns) return

    let totalTokens
    try {
      const m = tokenMeter.measure(session)
      totalTokens = m?.totalTokens
    } catch {
      return
    }
    if (typeof totalTokens !== 'number' || totalTokens < config.minTokens) return

    const window = contextWindowOf(session, config.contextWindow)
    if (window <= 0 || totalTokens / window < config.pressureRatio) return

    stats?.bump('compactionDriver.checks', 1)
    state.inFlight = true
    state.compactionsDone += 1
    // 让 idle 事件派发栈先退栈,再进入 runMaintenance
    setImmediate(() => {
      runCompaction(agent, state).catch(() => {})
    })
  }

  const onDisposed = (payload) => {
    const agent = payload?.agent
    if (agent?.id !== undefined) states.delete(agent.id)
  }

  ctx.on('agent/status', onStatus)
  listeners.push(() => ctx.off('agent/status', onStatus))
  ctx.on('agent/disposed', onDisposed)
  listeners.push(() => ctx.off('agent/disposed', onDisposed))
  return () => {
    states.clear()
    for (const off of listeners) off()
  }
}
