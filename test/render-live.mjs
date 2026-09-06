// 真机环境验证 text2img 渲染链路(需在普通终端/真机权限运行)
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/render-text.ps1', import.meta.url))
console.log('render script:', script)
const text = '第 1 段:这是真实环境渲染测试内容。'.repeat(300)
const out = join(tmpdir(), `t2i-live-${Date.now()}.png`)
console.log('out:', out)
console.log('text chars:', text.length)

const child = spawn('powershell', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-text', text, '-outPath', out, '-width', '1200', '-fontSize', '16',
], { windowsHide: true })

let stderr = ''
child.stderr.on('data', (d) => { stderr += d })
child.on('error', (e) => { console.log('SPAWN ERROR:', e.message) })
child.on('close', (code) => {
  console.log('close code:', code)
  console.log('stderr:', stderr.slice(0, 300))
  console.log('png exists:', existsSync(out), existsSync(out) ? `${statSync(out).size} bytes` : '')
})
