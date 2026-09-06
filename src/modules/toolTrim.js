// 工具可见性管理(toolTrim / toolGate):按会话裁剪工具 schema + MCP 懒加载。
//
// v1(保留):监听 agent/created,对每个 agent 作用域调 tools.restrict({allow,deny})
// 裁剪"继承到的工具",未用工具的描述不再进请求,省固定 token。
//
// v2 新增 mcpLazy:MCP 工具全量 schema 每请求注入(dsh-mcp-client 启动即注册到
// 全局层),对低频使用的 MCP 服务器是纯浪费。本模块检测 mcp__* 前缀工具:
//   - 默认全部 deny(模型看不到 = schema 不进请求)
//   - 注册 mcp_load_tools 元工具(agent 作用域自注册,restrict 豁免、永远可见),
//     description 携带轻量索引(服务器名+工具名+一句话)
//   - 模型调用元工具按名放行 → 该工具从下次请求起可见,会话内保持
// 无 mcp__* 工具时全程 no-op(未配 MCP 的部署装上也不影响任何东西)。
//
// 关键机制(核心源码核实):
//   - restrict 多次调用是 AND 交集(dsh-tools admits 要求全 filter 放行),
//     动态放行必须 dispose 全部旧 restrict 再重挂新 filter;
//     重挂采用"先挂新、后撤旧",交集窗口期 = 旧 filter 本身,不会提前放行,
//     挂新失败则旧 filter 完好(fail-closed)
//   - mcp 客户端重连会 dispose 旧代工具/注册新代(名字可能变),每次挂载前
//     都用 tools.view(agent).restrictableNames 过滤失效名字,tools/change
//     事件触发重新发现与重挂
//   - defineTool 经 createRequire 从 @deepseek-ai/dsh-tools 解析(与
//     dsh-undo-savepoint 同款模式,DSH_ROOT 兜底),解析失败则 mcpLazy 降级禁用、
//     静态裁剪不受影响
//
// cordis 规则:所有服务访问 try/catch,失败只 console.warn,绝不破坏会话。

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
}

// 解析核心的 defineTool(不声明为依赖,运行时经 createRequire 借道)。
// 多锚点:插件自身位置(link 挂载时走不到 profile 依赖桥)→ DSH_ROOT →
// DSH_HOME/.dsh 的 profiles/node_modules(CLI 安装器生成的符号链接桥,
// 指回全局 CLI 树,dsh-undo-savepoint 同款依赖)→ 全局 npm 目录。
// 全部失败返回 undefined,mcpLazy 降级禁用,静态裁剪不受影响。
function resolveDefineTool() {
  const anchors = []
  anchors.push(import.meta.url) // 插件自身位置
  if (process.env.DSH_ROOT) anchors.push(join(process.env.DSH_ROOT, 'package.json'))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  anchors.push(join(dshHome, 'profiles', 'node_modules', 'noop.js'))
  if (process.env.APPDATA) anchors.push(join(process.env.APPDATA, 'npm', 'node_modules', 'noop.js'))
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      req.resolve('@deepseek-ai/dsh-tools')
      const mod = req('@deepseek-ai/dsh-tools')
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool
    } catch { /* 下一锚点 */ }
  }
  return undefined
}

function getView(tools, agent) {
  try {
    if (tools && typeof tools.view === 'function') {
      const v = tools.view(agent)
      if (v && v.restrictableNames instanceof Set) return v
    }
  } catch { /* view 半公开 API,失败走降级 */ }
  return null
}

function discoverMcp(view, prefix) {
  return [...view.restrictableNames].filter((n) => n.startsWith(prefix)).sort()
}

function buildIndex(view, allMcp) {
  const parts = []
  let total = 0
  for (const name of allMcp) {
    const desc = view?.visible?.get?.(name)?.description ?? ''
    const line = `${name}: ${String(desc).split('\n')[0].slice(0, 120)}`
    parts.push(line)
    total += line.length
    if (total > 2000) {
      parts.push('...(索引截断)')
      break
    }
  }
  return parts.join('; ')
}

export function createToolTrimModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled) return () => {}

  const allow = Array.isArray(config.allow) ? config.allow.filter((n) => typeof n === 'string') : []
  const deny = Array.isArray(config.deny) ? config.deny.filter((n) => typeof n === 'string') : []
  const mcpLazy = config.mcpLazy
  const defineTool = deps.defineTool ?? resolveDefineTool()

  if (allow.length === 0 && deny.length === 0 && (!mcpLazy || typeof defineTool !== 'function')) {
    // 空 filter 且无 MCP 能力:no-op(保留 v1 告警)
    console.warn('[dsh-token-optimizer] toolTrim 已启用但 allow/deny 均为空且未启用 mcpLazy,裁剪未生效')
    return () => {}
  }

  if (!ctx || typeof ctx.on !== 'function') {
    console.warn('[dsh-token-optimizer] toolTrim 已启用但 ctx.on 不可用,裁剪未生效')
    return () => {}
  }

  let warnedNoDefineTool = false
  const gates = new Map() // agentId -> { agent, tools, disposer, metaDisposer, allMcp, released, metaRegistered, lastFilterKey }

  function disposeGate(gate) {
    try { if (typeof gate?.metaDisposer === 'function') gate.metaDisposer() } catch { /* 忽略 */ }
    try { if (typeof gate?.disposer === 'function') gate.disposer() } catch { /* 忽略 */ }
    gate.metaDisposer = undefined
    gate.disposer = undefined
  }

  // 合成 filter(静态 allow/deny 与 mcp 放行合并进同一条 restrict,避免 AND 交集问题)
  // 先挂新、后撤旧;挂新失败则旧 gate 原样(fail-closed)
  async function mountGate(gate, view) {
    const restrictable = view?.restrictableNames ?? null
    const valid = (name) => !restrictable || restrictable.has(name)
    let nextAllow = allow.filter(valid)
    let nextDeny = deny.filter(valid)
    if (gate.allMcp.length > 0) {
      if (nextAllow.length > 0) {
        nextAllow = [...nextAllow, ...gate.released].filter(valid)
      } else {
        nextDeny = [...nextDeny, ...gate.allMcp.filter((n) => !gate.released.has(n))].filter(valid)
      }
    }
    const filter = {}
    if (nextAllow.length > 0) filter.allow = nextAllow
    if (nextDeny.length > 0) filter.deny = nextDeny

    // 幂等:filter 未变化不重挂。restrict 会经作用域 admission 变化触发
    // tools/change → 本模块 onToolsChange 再重挂 → 再触发 change 的死循环
    // (真实事故:harness 被循环到 OOM)。filterKey 只在 restrict 成功后才记录,
    // 失败时不记录,允许下次用同 filter 重试。
    const filterKey = JSON.stringify(filter)
    if (gate.lastFilterKey === filterKey) return

    let newDisposer
    if (filter.allow || filter.deny) {
      try {
        const d = gate.tools.restrict(filter)
        if (typeof d === 'function') newDisposer = d
        stats?.bump('tooltrim.applied', 1)
        stats?.addSample({ module: 'tooltrim', allow: nextAllow.length, deny: nextDeny.length, mcpReleased: gate.released.size })
      } catch (err) {
        console.warn(`[dsh-token-optimizer] toolTrim 未生效:${err?.message ?? err}`)
        return
      }
    }
    const old = gate.disposer
    gate.disposer = newDisposer ?? (() => {})
    gate.lastFilterKey = filterKey
    if (old) {
      try { old() } catch { /* 忽略 */ }
    }
    if (filter.allow || filter.deny) {
      console.log(`[dsh-token-optimizer] toolTrim 生效:agent "${gate.agent?.id ?? '?'}" 已按 allow ${nextAllow.length} / deny ${nextDeny.length} 裁剪工具(mcp 放行 ${gate.released.size})`)
    }
  }

  async function registerMetaTool(gate, view) {
    if (!mcpLazy || typeof defineTool !== 'function' || gate.allMcp.length === 0) return
    if (!gate.tools || typeof gate.tools.register !== 'function') return
    // 幂等:索引没变化且已注册过就跳过(agent/created 与 tools/change 双路触发)
    const indexText = buildIndex(view, gate.allMcp)
    if (gate.metaRegistered && gate.metaIndex === indexText) return
    // 旧 meta 先撤(索引随重连变化时刷新)
    try { if (typeof gate.metaDisposer === 'function') gate.metaDisposer() } catch { /* 忽略 */ }
    gate.metaDisposer = undefined
    const definition = defineTool({
      name: config.mcpLoadToolName,
      description: '按需放行 MCP 工具(懒加载)。默认全部 MCP 工具不可见,调用本工具指定名字后,这些工具才会出现在后续请求中并保持到会话结束。当前可用索引: ' + indexText,
      parameters: {
        names: { type: 'array', items: { type: 'string' }, description: '要放行的 mcp 工具名数组(如 mcp__server__tool)' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const agent = exec?.agent
        const gateFor = agent?.id !== undefined ? gates.get(agent.id) : undefined
        const names = Array.isArray(args?.names) ? args.names.filter((n) => typeof n === 'string') : []
        if (!gateFor) return '未找到本会话的 MCP 门控状态(可能未发现 MCP 工具),放行未生效'
        const released = []
        const unknown = []
        for (const n of names) {
          if (gateFor.allMcp.includes(n)) {
            gateFor.released.add(n)
            released.push(n)
          } else {
            unknown.push(n)
          }
        }
        if (released.length > 0) {
          const freshView = getView(gateFor.tools, agent)
          await mountGate(gateFor, freshView)
          stats?.bump('toolgate.mcpReleased', released.length)
          stats?.bump('toolgate.remounts', 1)
        }
        const stillDenied = gateFor.allMcp.filter((n) => !gateFor.released.has(n))
        return `已放行: ${released.join(', ') || '(无)'};未知或不可放行: ${unknown.join(', ') || '(无)'};仍被拦截: ${stillDenied.join(', ') || '(无)'}`
      },
    })
    try {
      const d = gate.tools.register(definition)
      if (typeof d === 'function') gate.metaDisposer = d
      gate.metaRegistered = true
      gate.metaIndex = indexText
    } catch (err) {
      if (/already registered/i.test(String(err?.message ?? err))) {
        // 同名已注册(重复事件/作用域残留):视为已注册,不再重试,也不动别人的注册
        gate.metaRegistered = true
        gate.metaIndex = indexText
        return
      }
      console.warn(`[dsh-token-optimizer] toolTrim mcp 元工具注册失败:${err?.message ?? err}`)
    }
  }

  const onCreated = (payload) => {
    const agent = payload?.agent
    const agentCtx = agent?.ctx
    if (!agentCtx) return
    const id = agent?.id
    if (id !== undefined && gates.has(id)) return // 防御重复事件

    const tools = agentCtx.tools
    if (!tools || typeof tools.restrict !== 'function') {
      console.warn(`[dsh-token-optimizer] toolTrim: agent "${id ?? '?'}" 作用域拿不到 tools 服务,裁剪未生效`)
      return
    }

    const gate = { agent, tools, disposer: undefined, metaDisposer: undefined, allMcp: [], released: new Set() }
    if (id !== undefined) gates.set(id, gate)

    const view = getView(tools, agent)
    if (mcpLazy && view) {
      if (typeof defineTool === 'function') {
        gate.allMcp = discoverMcp(view, config.mcpPrefix)
        if (gate.allMcp.length > 0) stats?.bump('toolgate.mcpDetected', 1)
      } else if (!warnedNoDefineTool) {
        warnedNoDefineTool = true
        console.warn('[dsh-token-optimizer] toolTrim mcpLazy 已启用但无法解析 @deepseek-ai/dsh-tools 的 defineTool,mcp 懒加载降级禁用(静态裁剪不受影响)')
      }
    }

    // 先注册元工具(作用域自注册,restrict 豁免),再挂静态+mcp 拦截
    registerMetaTool(gate, view).then(() => mountGate(gate, view)).catch(() => {})
  }

  // mcp 客户端重连会换代工具(tools/change),重新发现 + 重挂 + 刷新索引。
  // 注意:restrict 本身也会经 admission 变化触发 tools/change——必须先比对
  // 工具集是否真的变了,不变直接返回,否则死循环(事故教训)。
  const onToolsChange = () => {
    for (const gate of gates.values()) {
      try {
        const view = getView(gate.tools, gate.agent)
        if (!view) continue
        if (!mcpLazy || typeof defineTool !== 'function') continue
        const allMcp = discoverMcp(view, config.mcpPrefix)
        const same = allMcp.length === gate.allMcp.length && allMcp.every((n, i) => n === gate.allMcp[i])
        if (same && [...gate.released].every((n) => allMcp.includes(n))) continue // 无真实变化
        for (const n of [...gate.released]) if (!allMcp.includes(n)) gate.released.delete(n)
        gate.allMcp = allMcp
        if (allMcp.length > 0) {
          registerMetaTool(gate, view).then(() => mountGate(gate, view)).catch(() => {})
        } else if (gate.metaDisposer) {
          disposeGate(gate)
        }
      } catch { /* 单个 gate 失败不影响其他 */ }
    }
  }

  const onDisposed = (payload) => {
    const id = payload?.agent?.id
    if (id === undefined) return
    const gate = gates.get(id)
    if (gate) {
      disposeGate(gate)
      gates.delete(id)
    }
  }

  ctx.on('agent/created', onCreated)
  ctx.on('tools/change', onToolsChange)
  ctx.on('agent/disposed', onDisposed)

  return () => {
    ctx.off('agent/created', onCreated)
    ctx.off('tools/change', onToolsChange)
    ctx.off('agent/disposed', onDisposed)
    for (const gate of gates.values()) disposeGate(gate)
    gates.clear()
  }
}
