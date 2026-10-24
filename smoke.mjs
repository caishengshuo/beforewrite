/**
 * 离线冒烟测试：不装插件，用假 ctx + 假 fs 服务把整条链路跑一遍。
 * 运行：node smoke.mjs
 */
import nfs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = nfs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'))
process.env.DSH_HOME = tmp

const ws = path.join(tmp, 'ws')
nfs.mkdirSync(ws, { recursive: true })
const file = path.join(ws, 'demo.txt')
nfs.writeFileSync(file, 'line1\nline2\nline3\nline4\n')

let tool
const listeners = {}

const fakeFs = {
  async resolve(p) {
    return { targetKey: p, displayPath: p }
  },
  async stat(t) {
    try {
      const s = nfs.statSync(t.displayPath)
      return { version: 'v1', type: s.isFile() ? 'file' : 'directory', size: s.size }
    } catch {
      return undefined
    }
  },
  async readBytes(t, _signal, _max) {
    const b = nfs.readFileSync(t.displayPath)
    return new Uint8Array(b)
  },
  async readText(t) {
    return nfs.readFileSync(t.displayPath, 'utf8')
  },
  async writeText(t, content) {
    const existed = nfs.existsSync(t.displayPath)
    const before = existed ? nfs.readFileSync(t.displayPath, 'utf8') : null
    nfs.writeFileSync(t.displayPath, content)
    return { operation: existed ? 'update' : 'create', version: 'v2', before, after: content }
  },
}

const ctx = {
  on(n, fn) {
    listeners[n] = fn
    return () => {}
  },
  get: () => fakeFs,
  tools: {
    register(def) {
      tool = def
      return () => {}
    },
  },
}

const mod = await import(pathToFileURL(path.resolve('index.js')).href)
const dispose = mod.apply(ctx)

const target = { targetKey: file, displayPath: file }

const r1 = await listeners['fs/write-intent'](target, undefined, async () => undefined)
console.log('① write-intent 返回值（应为 undefined）:', JSON.stringify(r1))

nfs.writeFileSync(file, 'line1\nBROKEN\nline3\n')
console.log('② 把文件改坏后内容:', JSON.stringify(nfs.readFileSync(file, 'utf8')))

let out = await tool.execute({ action: 'list' })
console.log('\n③ list\n' + out.text)

const id = Number(out.text.match(/#(\d+)/)[1])
console.log('\n③ 取到编号:', id)

out = await tool.execute({ action: 'diff', id })
console.log('\n④ diff\n' + out.text)

out = await tool.execute({ action: 'restore', id })
console.log('\n⑤ restore\n' + out.text)
console.log('⑤ 回滚后文件内容:', JSON.stringify(nfs.readFileSync(file, 'utf8')))

out = await tool.execute({ action: 'stats' })
console.log('\n⑥ stats\n' + out.text)

out = await tool.execute({ action: 'history', path: 'demo.txt' })
console.log('\n⑦ history\n' + out.text)

// ⑧ 手动打点：模拟 bash 里 rm 之前先留一手
out = await tool.execute({ action: 'snapshot', path: file, reason: 'before-bash-delete' })
console.log('\n⑧ snapshot\n' + out.text)
nfs.rmSync(file, { force: true })
console.log('⑧ 文件已被 rm，现在磁盘上还有吗:', nfs.existsSync(file))

out = await tool.execute({ action: 'list', limit: 3 })
console.log('\n⑨ list（rm 之后）\n' + out.text)
const lastId = Number(out.text.match(/#(\d+)/)[1])
out = await tool.execute({ action: 'restore', id: lastId })
console.log('\n⑩ restore（把删掉的文件救回来）\n' + out.text)
console.log('⑩ 文件回来了吗:', nfs.existsSync(file), JSON.stringify(nfs.readFileSync(file, 'utf8')))

dispose()
nfs.rmSync(tmp, { recursive: true, force: true })
console.log('\n✔ 冒烟测试结束')
