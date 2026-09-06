// 轻量统计:记录各模块的节省/处理次数,会话结束时输出报告。

export function createStats() {
  const counters = new Map()
  const samples = []

  function bump(key, delta = 1) {
    counters.set(key, (counters.get(key) ?? 0) + delta)
  }

  function addSample(entry) {
    samples.push(entry)
    if (samples.length > 1000) samples.shift()
  }

  function snapshot() {
    return {
      counters: Object.fromEntries(counters),
      samples: [...samples],
    }
  }

  function formatReport() {
    const c = Object.fromEntries(counters)
    const lines = []
    lines.push('── dsh-token-optimizer 会话统计 ──')
    for (const [key, value] of Object.entries(c)) {
      lines.push(`  ${key}: ${value}`)
    }
    const totalChars = samples.reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
    if (totalChars > 0) lines.push(`  共节省约 ${totalChars.toLocaleString()} 字符(压缩/去重)`)
    return lines.join('\n')
  }

  return {
    bump,
    addSample,
    snapshot,
    formatReport,
    dispose() {
      counters.clear()
      samples.length = 0
    },
  }
}
