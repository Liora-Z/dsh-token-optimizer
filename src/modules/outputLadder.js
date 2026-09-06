// 输出阶梯(outputLadder):tools/post-execute 单次遍历,按决策表分流处理工具结果投影。
//
// 合并了 v1 的三个模块并修正其问题:
//   - compress(结构压缩)/ sample(采样)迁移至此,分工具类型生效
//   - 原 pruning 的"截断"意图改为出生点处理(v1 挂在 agent/pre-step,但那里
//     永远看不到历史工具结果,实际是死代码)
//   - sample 原阈值 50000 字符被核心 spill(50000 字节,链最外层先跑)架空,
//     这里改为 8000 字符、只对 shell 类工具生效,填补 8k-50k 的裸奔区间
//
// 分流决策表(按序判定,首中即返回;每条替换都有"更短才替换"守卫):
//   1. read 类工具(首次读完整保留,重复读由 fileDiff 管)→ 放行
//   2. 无文本块 → 放行
//   3. result.isError → 错误摘要(errorSummaryChars),错误文本常是超长 traceback,
//      且结构压缩会破坏错误语义,所以必须最先处理
//   4. >= structureThreshold 且为 JSON 数组/CSV → 结构感知压缩,原文落盘可逆。
//      在字节判断之前:结构化压缩对 JSON/CSV 的信息密度远高于核心 spill 的
//      头尾预览;先压缩后 spill 看到的就是小内容,不会重复 spill
//   5. >= spillBytes 字节 → 放行,交给核心 spill(链最外层兜底;非结构化大输出
//      走它的头尾预览 + 落盘定位符)
//   6. shell 类工具且 >= shellThreshold → 头尾+等距采样(带行号),原文落盘可逆
//   7. 其余 → 放行

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_DIR = join(homedir(), '.dsh', 'token-optimizer', 'originals')

function ensureDir() {
  try {
    mkdirSync(ORIGINAL_DIR, { recursive: true })
  } catch {
    // 目录不可写时静默降级:压缩不落盘,仍可工作(仅不可还原)
  }
}

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

function saveOriginal(exec, text) {
  ensureDir()
  const name = String(exec?.name ?? 'tool').replace(/[^A-Za-z0-9_-]/g, '_')
  const file = join(ORIGINAL_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  try {
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

// ---- JSON 结构压缩(自 v1 compress 迁移) ----
function compressJsonArray(text, { compressionRate, preserveHeadTail }) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length <= 4) return null

  const total = parsed.length
  // 采样数上限 500:再大的数组摘要也封顶(约 45k 字符),避免超大数组
  // 把压缩结果本身撑回 spill 区间
  const sampleCount = Math.max(2, Math.min(total, 500, Math.ceil(total * compressionRate)))
  const step = total / sampleCount
  const picked = []
  for (let i = 0; i < sampleCount; i++) picked.push(parsed[Math.min(total - 1, Math.floor(i * step))])

  // 提取 schema:取首元素的键集合作为列名
  const first = parsed[0]
  const columns = first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : null

  const summary = {
    kind: 'json-array-compressed',
    totalRows: total,
    sampledRows: picked.length,
    columns,
    sample: picked,
  }
  const out = JSON.stringify(summary)
  if (out.length >= text.length) return null // 没省下字符就不压缩
  return out
}

// ---- CSV 结构压缩(自 v1 compress 迁移) ----
// v1 的缺陷:任何多行文本都会被当 CSV 压缩(含 pwsh 输出)。这里加列一致性
// 启发式:表头含分隔符且前几条 body 行列数一致才算 CSV。
function compressCsv(text, { preserveHeadTail }) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length <= 8) return null
  const header = lines[0]
  const delim = header.includes('\t') ? '\t' : header.includes(',') ? ',' : null
  if (!delim) return null
  const headerCols = header.split(delim).length
  if (headerCols < 2) return null
  const checks = lines.slice(1, 4).map((line) => line.split(delim).length)
  if (!checks.every((count) => count === headerCols)) return null
  const body = lines.slice(1)
  const total = body.length
  const head = body.slice(0, preserveHeadTail)
  const tail = body.slice(-preserveHeadTail)
  const out = [header, `[... ${total - head.length - tail.length} 行已省略,原始数据已存盘 ...]`, ...head, ...tail].join('\n')
  if (out.length >= text.length) return null
  return out
}

// ---- 错误摘要(新增,替代 v1 pruning 的"删旧失败输出"意图) ----
function summarizeError(text, maxChars) {
  if (text.length <= maxChars) return null
  const head = text.slice(0, maxChars)
  return `${head}\n\n[... dsh-token-optimizer outputLadder: 错误输出已摘要(原 ${text.length} 字符,保留前 ${maxChars} 字符) ...]`
}

// ---- shell 输出采样(自 v1 sample 迁移,只对 shell 类工具,新增落盘可逆) ----
function sampleShell(text, config) {
  const lines = text.split(/\r?\n/)
  if (lines.length <= config.headLines + config.tailLines + 2) return null

  const head = lines.slice(0, config.headLines)
  const tail = lines.slice(-config.tailLines)
  const middle = lines.slice(config.headLines, lines.length - config.tailLines)

  const sampled = []
  for (let i = 0; i < middle.length; i += config.sampleInterval) {
    const originalIndex = config.headLines + i
    sampled.push(`${originalIndex + 1}\t${middle[i]}`)
  }

  const numbered = (lines2, start) => lines2.map((line, i) => `${start + i + 1}\t${line}`)
  const headNumbered = numbered(head, 0)
  const tailNumbered = numbered(tail, lines.length - tail.length)

  return [
    `[dsh-token-optimizer outputLadder: 共 ${lines.length} 行,已采样展示头 ${config.headLines} 行 + 等距 ${sampled.length} 行 + 尾 ${config.tailLines} 行]`,
    ...headNumbered,
    ...sampled,
    ...tailNumbered,
  ].join('\n')
}

export function createOutputLadderModule(ctx, config, stats) {
  const listeners = []
  if (typeof ctx?.on !== 'function') return () => {}

  const readTools = new Set(config.readTools ?? [])
  const shellTools = new Set(config.shellTools ?? [])

  const handler = async (exec, result, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'accept') return decision

    // 1) read 类工具豁免:首次读完整保留,重复读由 fileDiff 管
    if (readTools.has(exec?.name)) return decision

    const blocks = result?.content
    const text = toText(blocks)
    // 2) 无文本块
    if (text.length === 0) return decision

    let replacement = null
    let branch = null

    // 3) 错误结果:摘要化(必须最先,错误文本常是超长 traceback)
    if (result?.isError === true) {
      replacement = summarizeError(text, config.errorSummaryChars)
      branch = 'error'
    }

    // 4) 结构感知压缩(JSON 数组/CSV),在字节判断之前:压缩后 spill 不会再介入
    if (!replacement && text.length >= config.structureThreshold) {
      replacement = compressJsonArray(text, config) ?? compressCsv(text, config)
      branch = 'structured'
    }

    // 5) >= spillBytes 字节:交给核心 spill(链最外层兜底),不重复做
    if (!replacement && Buffer.byteLength(text, 'utf8') >= config.spillBytes) {
      stats?.bump('ladder.spillSkip', 1)
      return decision
    }

    // 6) shell 类工具输出采样
    if (!replacement && shellTools.has(exec?.name) && text.length >= config.shellThreshold) {
      replacement = sampleShell(text, config)
      branch = 'shell'
    }

    if (!replacement || replacement.length >= text.length) return decision

    // 原文落盘(可逆),标记带原始路径
    let marker
    if (config.saveOriginal) {
      const savedFile = saveOriginal(exec, text)
      marker = savedFile ? `(原始数据:${savedFile})` : '(原始数据未落盘)'
    } else {
      marker = '(saveOriginal 关闭)'
    }
    const final = `${replacement}\n\n[已由 dsh-token-optimizer outputLadder.${branch} 处理 ${marker}]`

    const savedChars = text.length - final.length
    if (savedChars <= 0) return decision

    stats?.bump(`ladder.${branch === 'error' ? 'errors' : branch}`, 1)
    stats?.bump('ladder.savedChars', savedChars)
    stats?.addSample({ module: 'outputLadder', tool: exec?.name, branch, savedChars })

    return {
      kind: 'accept',
      content: foldTextBlocks(blocks, final),
    }
  }

  ctx.on('tools/post-execute', handler)
  listeners.push(() => ctx.off('tools/post-execute', handler))
  return () => {
    for (const off of listeners) off()
  }
}
