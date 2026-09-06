// 结果缓存:相同工具调用(名称+参数指纹)在 TTL 内命中时,短路执行并复用结果。
//
// 落点:tools/execute 是 around-dispatch 瀑布 —— 命中缓存时直接返回缓存的
// ToolExecutionResult,不调用 next()(不执行工具);未命中则 next() 执行并存入缓存。
//
// 只对"纯函数型"工具缓存(由 allowlist 控制,默认只缓存只读类工具):
// 写操作/有时效性的工具(web 搜索、发消息等)绝不能缓存。

import { createHash } from 'node:crypto'

// 默认只缓存这些确定性只读工具(可通过配置 allowlist 覆盖;空数组=全部按 allowlist 判断)。
// 注意:默认不含 read——重复读同一文件交给 fileDiff 按内容哈希记忆更安全(能区分改动与否),
// cache 若按 path+TTL 缓存 read,会让改动后的文件读回过期内容。要缓存 read 需在配置里显式先入 allowlist。
const DEFAULT_ALLOWLIST = ['glob', 'grep']

function fingerprint(name, args) {
  const hash = createHash('sha256')
  hash.update(String(name))
  hash.update('\0')
  try {
    hash.update(JSON.stringify(args ?? {}))
  } catch {
    hash.update('[unserializable]')
  }
  return hash.digest('hex').slice(0, 24)
}

function isCacheable(name, config) {
  const allowlist = config.allowlist && config.allowlist.length > 0 ? config.allowlist : DEFAULT_ALLOWLIST
  return allowlist.includes(String(name))
}

export function createCacheModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}
  const store = new Map() // key -> { expiresAt, result }

  const handler = async (exec, next) => {
    if (!isCacheable(exec?.name, config)) return next()

    const key = fingerprint(exec.name, exec.arguments)
    const now = Date.now()
    const hit = store.get(key)
    if (hit && hit.expiresAt > now) {
      stats?.bump('cache.hits', 1)
      stats?.addSample({ module: 'cache', tool: exec.name, hit: true })
      return structuredClone(hit.result)
    }
    if (hit) store.delete(key)

    const result = await next()
    // 只缓存成功结果
    if (result && !result.isError) {
      store.set(key, { expiresAt: now + (config.ttl ?? 3600) * 1000, result })
      // 简单容量保护
      if (store.size > 512) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      stats?.bump('cache.stores', 1)
      stats?.addSample({ module: 'cache', tool: exec.name, hit: false })
    }
    return result
  }

  ctx.on('tools/execute', handler)
  listeners.push(() => ctx.off('tools/execute', handler))
  return () => {
    store.clear()
    for (const off of listeners) off()
  }
}
