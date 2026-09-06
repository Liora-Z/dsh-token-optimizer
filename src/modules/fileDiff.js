// 重复读文件 → 增量 diff(fileDiff):在 tools/post-execute 层记忆"文件路径+内容哈希",
// 会话内再次读到同一路径时:
//   - 内容未变(哈希相同)  → 折叠为"文件未变化"简短标记,不再重发全文;
//   - 内容变了(哈希不同)  → 只发变更区段 diff,不再重发全文。
// 与 dedup 的区别:dedup 只抓"同一请求内字节完全相同";本模块跨调用记住文件,
// 能抓"同一文件改了一行"或"未变化但反复被读"。
//
// 可逆:每次触发置换时把该文件的最新完整内容落盘(originals 目录),标记里带路径;
// 未触发时只缓存哈希+内容,不落盘、不改动投影。
//
// 落点:tools/post-execute,替换模型看到的 content 投影(value 不变,规范 JSON 无损)。

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const ORIGINAL_DIR = join(homedir(), '.dsh', 'token-optimizer', 'filediff-originals')

function textBlocks(blocks) {
  return (blocks ?? []).filter((block) => block?.type === 'text')
}
function toText(blocks) {
  return textBlocks(blocks).map((block) => block.text).join('\n')
}
// 折叠投影:replacement 只进第一个 text 块,其余 text 块丢弃(避免多块时标记重复出现)
function foldTextBlocks(blocks, replacement) {
  let replacedFirst = false
  return (blocks ?? []).flatMap((block) => {
    if (block?.type !== 'text') return [block]
    if (!replacedFirst) {
      replacedFirst = true
      return [{ ...block, text: replacement }]
    }
    return []
  })
}
function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}
function pathOf(exec) {
  const args = exec?.arguments ?? {}
  return typeof args.path === 'string' ? args.path
    : typeof args.file_path === 'string' ? args.file_path
      : typeof args.file === 'string' ? args.file
        : undefined
}

// 朴素安全 diff:公共前缀/后缀截掉,只展示中间变更区段 + 少量上下文(行级)。
// 不追求 LCS 最优,只要"能看到改了什么"即可;变更区段过大时等距采样提示。
function buildDiff(oldText, newText, contextLines) {
  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)
  let p = 0
  const maxP = Math.min(oldLines.length, newLines.length)
  while (p < maxP && oldLines[p] === newLines[p]) p++
  let s = 0
  const maxS = Math.min(oldLines.length - p, newLines.length - p)
  while (s < maxS && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++

  const oldChanged = oldLines.slice(p, oldLines.length - s)
  const newChanged = newLines.slice(p, newLines.length - s)

  // 变更区段的上下文窗口
  const ctxBefore = newLines.slice(Math.max(0, p - contextLines), p)
  const ctxAfter = newLines.slice(newLines.length - s, newLines.length - s + contextLines)

  const cap = 200 // 变更行数上限,超出则采样
  let body = []
  const removed = oldChanged.length
  const added = newChanged.length
  if (newChanged.length > cap) {
    body.push(`  …[变更区段 ${newChanged.length} 行,仅展示首尾等距]…`)
    for (let i = 0; i < newChanged.length; i += Math.ceil(newChanged.length / cap)) {
      body.push(`+ ${newChanged[i]}`)
    }
  } else {
    for (const line of newChanged) body.push(`+ ${line}`)
  }

  const lines = []
  lines.push(`[dsh-token-optimizer fileDiff: 文件已变更(删除 ${removed} 行 / 新增 ${added} 行),省略 ${p} 行未变前缀与 ${s} 行未变后缀]`)
  for (const line of ctxBefore) lines.push(`  ${line}`)
  lines.push('  …变更区段…')
  lines.push(...body)
  for (const line of ctxAfter) lines.push(`  ${line}`)
  return lines.join('\n')
}

function saveOriginal(path, text) {
  try {
    mkdirSync(ORIGINAL_DIR, { recursive: true })
    const file = join(ORIGINAL_DIR, `diff-${hashOf(path)}.txt`)
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

export function createFileDiffModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  const tools = config.tools?.length > 0 ? config.tools : ['read']
  const memory = new Map() // path -> { hash, text }
  const MAX_TRACK = 256

  const handler = async (exec, result, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'accept') return decision
    if (result?.isError) return decision

    const name = exec?.name
    if (!tools.includes(name)) return decision

    const args = exec?.arguments ?? {}
    // 分段读取(offset/limit)不参与追踪/折叠:同一文件的两个不同窗口哈希不同,
    // 会被误判为"文件变更"并发出一份误导模型的假 diff;只处理整文件读取。
    if (args.offset !== undefined || args.limit !== undefined) return decision

    const path = pathOf(exec)
    if (!path) return decision

    const blocks = result?.content
    const text = toText(blocks)
    if (text.length < config.minSize) return decision
    if (Buffer.byteLength(text, 'utf8') > config.maxFileBytes) return decision // 太大,放弃,放行

    const hash = hashOf(text)
    const prev = memory.get(path)

    if (!prev) {
      // 首次读:只在内存记录,不改动投影、不落盘
      if (memory.size >= MAX_TRACK) {
        const first = memory.keys().next().value
        if (first !== undefined) memory.delete(first)
      }
      memory.set(path, { hash, text })
      stats?.bump('filediff.tracks', 1)
      return decision
    }

    if (prev.hash === hash) {
      // 内容未变:折叠为简短标记(可逆,原文已落盘)
      if (!config.collapseUnchanged) return decision
      const file = saveOriginal(path, text)
      const replacement = `[dsh-token-optimizer fileDiff: 文件未变化(与上次读取相同),已省略 ${text.length} 字符${file ? `;原文已存 ${file}` : ''}]`
      if (replacement.length >= text.length) return decision
      stats?.bump('filediff.unchanged', 1)
      stats?.addSample({ module: 'filediff', tool: name, savedChars: text.length - replacement.length })
      return {
        kind: 'accept',
        content: foldTextBlocks(blocks, replacement),
      }
    }

    // 内容变了:发 diff;先更新记忆(存新全文,供下次继续 diff),
    // 再判断是否真的省下字符——diff 不省时也照常记住,避免下次对旧基线重复 diff
    memory.set(path, { hash, text })
    const file = saveOriginal(path, text)
    const diff = buildDiff(prev.text, text, config.contextLines)
    const replacement = `${diff}${file ? `\n[全文已存 ${file}]` : ''}`
    if (replacement.length >= text.length) return decision
    stats?.bump('filediff.changed', 1)
    stats?.addSample({ module: 'filediff', tool: name, savedChars: text.length - replacement.length })
    return {
      kind: 'accept',
      content: foldTextBlocks(blocks, replacement),
    }
  }

  ctx.on('tools/post-execute', handler)
  listeners.push(() => ctx.off('tools/post-execute', handler))
  return () => {
    memory.clear()
    for (const off of listeners) off()
  }
}
