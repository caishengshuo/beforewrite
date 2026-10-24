/**
 * 文件时光机 · fs-time-machine
 *
 * 挂在两个 waterfall 钩子上，在文件被写坏之前先把旧内容存起来：
 *   - fs/write-intent  每次 writeText 之前（write 工具、补丁、你自己的脚本）
 *   - fs/edit-intent   每次 editText  之前（edit 工具）
 *
 * 然后通过 time_machine 工具给出 list / history / diff / restore / stats 五个动作。
 *
 * 设计原则：监听器永远不抛错、永远不改变别人的决策（原样把 next() 还回去），
 * 出问题最多是没记上，绝不影响写盘本身。
 */

import { createHash } from 'node:crypto'
import nfs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'fs-time-machine'
export const inject = ['fs', 'tools']

/** 单个快照的字节上限；再大的文件只记一条「跳过了」的元信息。 */
const MAX_BYTES = 2 * 1024 * 1024
/** 索引最多回读多少行。 */
const INDEX_LIMIT = 20000
/** 行数超过这个值就不做逐行 diff，只给粗粒度差异。 */
const DIFF_CAP = 800
/** 自家仓库目录不自我快照。 */
const IGNORE = /[\\/](node_modules|\.git|time-machine)[\\/]/i

function storeRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'time-machine')
}

const ROOT = storeRoot()
const BLOB_DIR = path.join(ROOT, 'blobs')
const INDEX_FILE = path.join(ROOT, 'index.jsonl')
/** 会话事件流（说过的哪句话 / 做过哪些事），供时间轴界面读取。 */
const SESS_FILE = path.join(ROOT, 'sessions.jsonl')
const EVENT_LIMIT = 20000
/** 单条台词最多存多少字。 */
const SAYS_CAP = 400

function ensureDirs() {
  nfs.mkdirSync(BLOB_DIR, { recursive: true })
}

function message(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

function appendIndex(entry) {
  try {
    ensureDirs()
    nfs.appendFileSync(INDEX_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* 索引写不进去也不该影响业务 */
  }
}

function debug(line) {
  try {
    ensureDirs()
    const file = path.join(ROOT, 'debug.log')
    let size = 0
    try { size = nfs.statSync(file).size } catch { size = 0 }
    if (size > 262144) return
    nfs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* 调试也不能影响业务 */
  }
}

function readIndex() {
  const out = []
  let raw = ''
  try {
    raw = nfs.readFileSync(INDEX_FILE, 'utf8')
  } catch {
    return out
  }
  const lines = raw.split('\n')
  const start = Math.max(0, lines.length - INDEX_LIMIT)
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      out.push({ ...parsed, id: i + 1 })
    } catch {
      /* 半行/坏行直接跳过 */
    }
  }
  return out
}

function appendSession(entry) {
  try {
    ensureDirs()
    nfs.appendFileSync(SESS_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* 事件流水写不进去也不能影响会话本身 */
  }
}

function readSessionLog() {
  const out = []
  let raw = ''
  try {
    raw = nfs.readFileSync(SESS_FILE, 'utf8')
  } catch {
    return out
  }
  const lines = raw.split('\n')
  const start = Math.max(0, lines.length - EVENT_LIMIT)
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 注入型消息的头，这些不是「用户说的话」，时间轴里不该出现。 */
const NOISE_HEAD = /^(<hindsight_knowledge|<hindsight_knowledge_refresh|<engram_memory_context|<system-reminder|<untrusted-memory|Current runtime context|<available_skills>|<current_user_request>)/i

function cleanSays(text) {
  let out = String(text || '')
  out = out.replace(/<untrusted-memory>[\s\S]*?<\/untrusted-memory>/gi, ' ')
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
  out = out.replace(/<hindsight_knowledge[^>]*>[\s\S]*?<\/hindsight_knowledge>/gi, ' ')
  out = out.replace(/<hindsight_knowledge_refresh[^>]*>[\s\S]*?<\/hindsight_knowledge_refresh>/gi, ' ')
  out = out.replace(/<engram_memory_context[^>]*>[\s\S]*?<\/engram_memory_context>/gi, ' ')
  out = out.replace(/<current_user_request>[\s\S]*?<\/current_user_request>/gi, ' ')
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function isNoiseSays(entry) {
  if (!entry || entry.kind !== 'says') return false
  const text = String(entry.text || '').trim()
  return !text || NOISE_HEAD.test(text)
}

function textOf(message) {
  try {
    if (!message) return ''
    const content = message.content
    let raw = ''
    if (typeof content === 'string') raw = content
    else if (Array.isArray(content)) {
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      raw = parts.join('\n')
    }
    const trimmed = raw.trim()
    // 纯注入（记忆块、运行时上下文、技能清单）：整条丢掉，别让它污染「说过的哪句话」。
    if (!trimmed || NOISE_HEAD.test(trimmed)) return ''
    const cleaned = cleanSays(trimmed)
    return cleaned.slice(0, SAYS_CAP)
  } catch {
    /* 消息形状不合预期就算了 */
  }
  return ''
}

/** 从写盘钩子的 actor 里取出会话 id 与回合号（探针实测字段）。 */
function actorInfo(actor) {
  const out = { sid: '', turn: 0, step: 0, tool: '' }
  try {
    if (!actor) return out
    out.tool = String(actor.name || '')
    const agent = actor.agent
    if (agent) {
      out.sid = String(agent.id || '')
      if (!out.sid && agent.session && agent.session.id) out.sid = String(agent.session.id)
      const phase = agent.phase
      if (phase) {
        out.turn = Number(phase.turn) || 0
        out.step = Number(phase.step) || 0
      }
    }
  } catch {
    /* 拿不到就留空 */
  }
  return out
}

/** 某会话的完整时间轴：用户台词 + 工具动作 + 文件快照，按时间合并。 */
function timelineFor(sid) {
  const rows = []
  for (const e of readSessionLog()) {
    if (sid && e.sid !== sid) continue
    // 历史遗留：v4 之前把注入型消息也记成了台词，读出来时一并滤掉，别让旧记录污染界面。
    if (isNoiseSays(e)) continue
    rows.push({
      at: Number(e.at) || 0,
      kind: String(e.kind || 'event'),
      text: String(e.text || ''),
      turn: Number(e.turn) || 0,
      step: Number(e.step) || 0,
      sid: String(e.sid || ''),
    })
  }
  for (const s of readIndex()) {
    if (sid && s.sid !== sid) continue
    rows.push({
      at: Number(s.at) || 0,
      kind: 'snap',
      id: s.id,
      action: String(s.action || ''),
      text: String(s.path || ''),
      size: s.size,
      sha: !!s.sha,
      absent: !!s.absent,
      tooLarge: !!s.tooLarge,
      turn: Number(s.turn) || 0,
      sid: String(s.sid || ''),
    })
  }
  rows.sort((a, b) => a.at - b.at)
  return rows
}

function sessionsSummary() {
  const map = new Map()
  const touch = (sid) => {
    let row = map.get(sid)
    if (!row) {
      row = { sid, first: '', last: 0, events: 0, says: 0, snaps: 0 }
      map.set(sid, row)
    }
    return row
  }
  for (const e of readSessionLog()) {
    const sid = String(e.sid || '')
    if (!sid) continue
    if (isNoiseSays(e)) continue
    const row = touch(sid)
    row.events += 1
    if (Number(e.at) > row.last) row.last = Number(e.at) || 0
    if (!row.first && e.kind === 'says' && e.text) row.first = String(e.text).slice(0, 80)
    if (e.kind === 'says') row.says += 1
  }
  for (const s of readIndex()) {
    const sid = String(s.sid || '')
    if (!sid) continue
    const row = touch(sid)
    row.snaps += 1
    if (Number(s.at) > row.last) row.last = Number(s.at) || 0
  }
  return Array.from(map.values()).sort((a, b) => b.last - a.last)
}

function fmtTime(ts) {
  const d = new Date(typeof ts === 'number' ? ts : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) +
    ':' + p(d.getMinutes()) +
    ':' + p(d.getSeconds())
  )
}

function fmtSize(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '?'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function blobPath(sha) {
  return path.join(BLOB_DIR, sha)
}

/**
 * 拍一张「写之前」的快照。任何异常都被吞掉并记进索引，绝不打断写盘。
 */
async function snapshot(fsService, target, action, meta) {
  const info0 = meta && typeof meta === 'object' ? meta : {}
  debug('snapshot 进入 action=' + action + ' display=' + String(target && target.displayPath) + ' fs=' + (fsService ? 'ok' : 'undefined') + ' sid=' + String(info0.sid || '-'))
  if (!fsService || !target) return
  const display = String(target.displayPath || '')
  const key = String(target.targetKey || '')
  if (!display || IGNORE.test(display)) return
  const base = {
    action,
    path: display,
    key,
    sid: String(info0.sid || ''),
    turn: Number(info0.turn) || 0,
    step: Number(info0.step) || 0,
    tool: String(info0.tool || ''),
  }
  try {
    const info = await fsService.stat(target)
    if (!info || info.type !== 'file') {
      appendIndex({ at: Date.now(), ...base, absent: true })
      return
    }
    if (typeof info.size === 'number' && info.size > MAX_BYTES) {
      appendIndex({ at: Date.now(), ...base, tooLarge: true, size: info.size })
      return
    }
    const bytes = await fsService.readBytes(target, undefined, MAX_BYTES)
    const sha = createHash('sha256').update(bytes).digest('hex')
    ensureDirs()
    const file = blobPath(sha)
    if (!nfs.existsSync(file)) nfs.writeFileSync(file, bytes)
    appendIndex({ at: Date.now(), ...base, sha, size: bytes.byteLength })
  } catch (error) {
    appendIndex({ at: Date.now(), ...base, error: message(error) })
  }
}

function readBlob(sha) {
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return undefined
  try {
    return nfs.readFileSync(blobPath(sha))
  } catch {
    return undefined
  }
}

function diffLines(oldText, newText) {
  const a = oldText.split(/\r?\n/)
  const b = newText.split(/\r?\n/)

  if (a.length > DIFF_CAP || b.length > DIFF_CAP) {
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1
    let suf = 0
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) suf += 1
    return [
      '（文件较大，只给粗粒度差异）',
      '快照 ' + a.length + ' 行 → 当前 ' + b.length + ' 行',
      '相同前缀 ' + pre + ' 行，相同后缀 ' + suf + ' 行',
      '变化区间：旧 ' + (pre + 1) + '-' + (a.length - suf) + ' 行 / 新 ' + (pre + 1) + '-' + (b.length - suf) + ' 行',
    ].join('\n')
  }

  const n = a.length
  const m = b.length
  const table = []
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ sign: ' ', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ sign: '-', text: a[i] })
      i += 1
    } else {
      ops.push({ sign: '+', text: b[j] })
      j += 1
    }
  }
  while (i < n) { ops.push({ sign: '-', text: a[i] }); i += 1 }
  while (j < m) { ops.push({ sign: '+', text: b[j] }); j += 1 }

  // 文件末尾的换行会 split 出一个空串，显示时没意义，去掉首尾的空上下文行。
  while (ops.length > 0 && ops[ops.length - 1].sign === ' ' && ops[ops.length - 1].text === '') ops.pop()
  while (ops.length > 0 && ops[0].sign === ' ' && ops[0].text === '') ops.shift()

  const changed = []
  for (let k = 0; k < ops.length; k += 1) if (ops[k].sign !== ' ') changed.push(k)
  if (changed.length === 0) return '内容一致，没有差异。'

  const keep = new Set()
  for (const k of changed) {
    for (let d = -3; d <= 3; d += 1) {
      const idx = k + d
      if (idx >= 0 && idx < ops.length) keep.add(idx)
    }
  }
  const sorted = Array.from(keep).sort((x, y) => x - y)

  const out = []
  let prev = -2
  let count = 0
  for (const idx of sorted) {
    if (count > 240) { out.push('… （差异过长，已截断）'); break }
    if (idx !== prev + 1) out.push('@@ …')
    out.push(ops[idx].sign + ' ' + ops[idx].text)
    prev = idx
    count += 1
  }
  const added = ops.filter((o) => o.sign === '+').length
  const removed = ops.filter((o) => o.sign === '-').length
  out.unshift('+' + added + ' 行 / -' + removed + ' 行')
  return out.join('\n')
}

function formatEntry(entry) {
  const tag = entry.absent
    ? '（当时还不存在）'
    : entry.tooLarge
      ? '（' + fmtSize(entry.size) + '，超过上限未存内容）'
      : entry.error
        ? '（快照失败：' + entry.error + '）'
        : fmtSize(entry.size)
  return '#' + entry.id + '  ' + fmtTime(entry.at) + '  ' + String(entry.action || '').padEnd(5) + '  ' + tag + '  ' + entry.path
}

function pick(entries, args) {
  const raw = String(args.path || '').trim()
  if (!raw) return entries
  const needle = raw.toLowerCase()
  return entries.filter((e) => String(e.path || '').toLowerCase().indexOf(needle) >= 0)
}

function limitOf(args) {
  const n = Number(args.limit)
  if (!Number.isFinite(n) || n <= 0) return 15
  return Math.min(200, Math.floor(n))
}

function findById(entries, id) {
  const n = Number(id)
  if (!Number.isFinite(n)) return undefined
  return entries.find((e) => e.id === n)
}

async function runList(entries, args) {
  const rows = pick(entries, args)
  if (rows.length === 0) return '还没有任何快照。文件被写一次之后就会有了。'
  const limit = limitOf(args)
  const slice = rows.slice(-limit).reverse()
  return (
    '最近 ' + slice.length + ' 条快照（共 ' + rows.length + ' 条，新 → 旧）：\n' +
    slice.map(formatEntry).join('\n') +
    '\n\n用 time_machine(action="diff", id=N) 看某个快照和当前文件的差异，' +
    'time_machine(action="restore", id=N) 回滚。'
  )
}

function runHistory(entries, args) {
  const raw = String(args.path || '').trim()
  if (!raw) return 'action="history" 需要 path 参数，例如 { action: "history", path: "src/app.ts" }。'
  const rows = pick(entries, args)
  if (rows.length === 0) return '没有匹配 ' + raw + ' 的快照。'
  const byKey = new Map()
  for (const row of rows) {
    const key = String(row.path || '')
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  }
  const chunks = []
  for (const [file, list] of byKey) {
    chunks.push(
      file + '  （' + list.length + ' 个版本，旧 → 新）\n' +
      list.map(formatEntry).join('\n')
    )
  }
  return chunks.join('\n\n')
}

async function runDiff(fsService, entries, args) {
  const entry = findById(entries, args.id)
  if (!entry) return '找不到编号 #' + String(args.id) + '，先用 action="list" 看有哪些。'
  if (entry.tooLarge) return '#' + entry.id + ' 因为文件超过 ' + fmtSize(MAX_BYTES) + ' 没有存内容，无法比较差异。'
  if (entry.absent) {
    return '#' + entry.id + ' 记录的是「当时文件还不存在」，所以没有旧内容可比。'
  }
  const bytes = readBlob(entry.sha)
  if (!bytes) return '#' + entry.id + ' 的内容块丢失了（' + entry.sha + '），无法比较。'

  const oldText = bytes.toString('utf8')
  let newText = ''
  try {
    const target = await fsService.resolve(entry.path)
    const info = await fsService.stat(target)
    newText = info && info.type === 'file' ? await fsService.readText(target) : ''
  } catch {
    newText = ''
  }

  const header =
    '#' + entry.id + '  ' + fmtTime(entry.at) + '  ' + entry.path + '\n' +
    '（旧 = 快照 / 新 = 现在）\n' +
    '─────────────────────────────'
  return header + '\n' + diffLines(oldText, newText)
}

async function runRestore(fsService, entries, args) {
  const entry = findById(entries, args.id)
  if (!entry) return '找不到编号 #' + String(args.id) + '，先用 action="list" 看有哪些。'
  if (entry.absent) {
    return '#' + entry.id + ' 记录的是「当时文件还不存在」，这条不能当作内容回滚。'
  }
  if (entry.tooLarge) return '#' + entry.id + ' 没有存内容（超过 ' + fmtSize(MAX_BYTES) + '），无法回滚。'
  const bytes = readBlob(entry.sha)
  if (!bytes) return '#' + entry.id + ' 的内容块丢失了（' + entry.sha + '），无法回滚。'

  let target
  try {
    target = await fsService.resolve(entry.path)
  } catch (error) {
    return '解析路径失败：' + message(error)
  }

  // 回滚本身也要可撤销：先把当前内容存一份。
  await snapshot(fsService, target, 'restore')

  try {
    const outcome = await fsService.writeText(target, bytes.toString('utf8'))
    return (
      '已回滚 ' + entry.path + '\n' +
      '恢复到 #' + entry.id + '（' + fmtTime(entry.at) + '）的状态，' +
      fmtSize(bytes.byteLength) + '，操作类型 ' + String(outcome && outcome.operation) + '。\n' +
      '回滚前的版本也存了一份，需要反悔就再 restore 那个新编号。'
    )
  } catch (error) {
    return '回滚写入失败：' + message(error)
  }
}

/**
 * 手动打点：给不经过 fs 服务的破坏性操作（bash 里的 rm / sed -i / 重定向）
 * 提前留一手。agent 在跑危险命令之前可以自己先调这个。
 */
async function runSnapshot(fsService, args) {
  const raw = String(args.path || '').trim()
  if (!raw) return 'action="snapshot" 需要 path 参数，例如 { action: "snapshot", path: "src/app.ts" }。'
  let target
  try {
    target = await fsService.resolve(raw)
  } catch (error) {
    return '解析路径失败：' + message(error)
  }
  const reason = String(args.reason || 'manual').slice(0, 40)
  await snapshot(fsService, target, reason)
  const latest = readIndex().slice(-1)[0]
  if (!latest) return '打点没成功，检查一下路径 ' + raw + ' 是否存在。'
  return (
    '已为 ' + target.displayPath + ' 打了一份快照 #' + latest.id +
    '（' + fmtTime(latest.at) + '，' + fmtSize(latest.size) + '，标记 ' + reason + '）。\n' +
    '之后文件被 rm 或被我改坏，' +
    (latest.sha ? '用 time_machine(action="restore", id=' + latest.id + ') 就能拿回来。' : '这条没有内容可恢复。')
  )
}

function runStats(entries) {
  const files = new Set()
  let blobs = 0
  let skipped = 0
  for (const e of entries) {
    files.add(String(e.path || ''))
    if (e.sha) blobs += 1
    if (e.tooLarge) skipped += 1
  }
  let diskBytes = 0
  try {
    for (const f of nfs.readdirSync(BLOB_DIR)) {
      try { diskBytes += nfs.statSync(path.join(BLOB_DIR, f)).size } catch { }
    }
  } catch { }
  return [
    '仓库：' + ROOT,
    '快照条数：' + entries.length,
    '涉及文件：' + files.size,
    '内容块：' + blobs + '（去重后占盘 ' + fmtSize(diskBytes) + '）',
    '超限跳过：' + skipped,
  ].join('\n')
}

function buildTool(readFs) {
  return {
    name: 'time_machine',
    description:
      '文件时光机。每次文件被 write 或 edit 之前，插件已经自动存下了旧内容。' +
      '用 list 看最近快照，history 看某个文件的全部版本，diff 看快照与当前文件的差异，restore 把文件回滚到某个快照，' +
      'snapshot 在跑 rm / sed -i 这类不经过写盘钩子的破坏性命令之前主动打点。' +
      '文件被改坏、被误删、需要对比改动时用它。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'history', 'diff', 'restore', 'stats', 'snapshot'],
          description: 'list 最近快照；history 某文件的全部版本；diff 与当前比较；restore 回滚；stats 仓库统计；snapshot 主动给某个文件打一份快照（bash 里的 rm / sed -i 这类不经过写盘钩子的操作，动手前先打点）。',
        },
        id: {
          type: 'number',
          description: '快照编号，就是 list/history 输出里的 #N。diff 与 restore 必填。',
        },
        path: {
          type: 'string',
          description: '文件路径。history 与 snapshot 必填，list 作过滤用（子串匹配）。',
        },
        reason: {
          type: 'string',
          description: 'snapshot 的标记，默认 manual。写清楚为什么打这一份，例如 before-bash-delete。',
        },
        limit: {
          type: 'number',
          description: 'list 最多返回多少条，默认 15，上限 200。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render(_args, value) {
        const text = value && typeof value.text === 'string' ? value.text : ''
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const fsService = readFs()
      const entries = readIndex()
      const input = args && typeof args === 'object' ? args : {}
      const action = String(input.action || 'list')

      if (!fsService) {
        return { ok: false, text: '文件系统服务当前不可用。' }
      }

      try {
        let text
        if (action === 'list') text = await runList(entries, input)
        else if (action === 'history') text = runHistory(entries, input)
        else if (action === 'diff') text = await runDiff(fsService, entries, input)
        else if (action === 'restore') text = await runRestore(fsService, entries, input)
        else if (action === 'snapshot') text = await runSnapshot(fsService, input)
        else if (action === 'stats') text = runStats(entries)
        else text = '未知的 action：' + action + '。可用：list / history / diff / restore / stats / snapshot。'
        return { ok: true, text }
      } catch (error) {
        return { ok: false, text: '时光机内部错误：' + message(error) }
      }
    },
  }
}

export function apply(ctx) {
  const readFs = () => {
    try {
      if (typeof ctx.get === 'function') {
        const byName = ctx.get('fs')
        if (byName) return byName
      }
    } catch {
      /* 继续往下试 */
    }
    return ctx.fs
  }

  ensureDirs()

  const disposers = []
  const keep = (off) => {
    if (typeof off === 'function') disposers.push(off)
  }

  // 关键：这两个钩子必须以 { global: true, prepend: true } 注册才会被派发到。
  // 实测结论（2026-10-24，本机 web profile）：
  //   ctx.on('fs/write-intent', fn)                        → 收不到
  //   ctx.on('fs/write-intent', fn, true)                  → 收不到
  //   ctx.on('fs/write-intent', fn, { prepend: true })     → 收不到
  //   ctx.on('fs/write-intent', fn, { global: true })      → 收不到
  //   ctx.on('fs/write-intent', fn, { global: true, prepend: true }) → 收到
  // 派发方是 tool-fs 自己的 ctx，非 global 的监听器不在它的注册表里。
  //
  // 另外：处理完必须把 next() 原样还回去。这是 waterfall 续延链，
  // next() 会继续交给后面的监听器（例如官方的 fs-observation-policy 先读后写守卫），
  // 直接返回 undefined 会把链掐断，等于替别人做了「无条件写」的决定。
  const OPTIONS = { global: true, prepend: true }

  const writeListener = async (target, actor, next) => {
    debug('write-intent 触发 display=' + String(target && target.displayPath))
    try {
      await snapshot(readFs(), target, 'write', actorInfo(actor))
    } catch {
      /* 绝不打断写盘 */
    }
    return typeof next === 'function' ? next() : undefined
  }

  const editListener = async (target, actor, next) => {
    debug('edit-intent 触发 display=' + String(target && target.displayPath))
    try {
      await snapshot(readFs(), target, 'edit', actorInfo(actor))
    } catch {
      /* 同上 */
    }
    return typeof next === 'function' ? next() : undefined
  }

  keep(ctx.on('fs/write-intent', writeListener, OPTIONS))
  keep(ctx.on('fs/edit-intent', editListener, OPTIONS))
  debug('apply final 完成，已挂 write-intent / edit-intent / snapshot 动作，ROOT=' + ROOT + ' OPTIONS=' + JSON.stringify(OPTIONS))

  try {
    keep(ctx.tools.register(buildTool(readFs)))
  } catch (error) {
    console.error('[fs-time-machine] 注册 time_machine 工具失败：' + message(error))
  }

  // ── 会话事件流：只观察，不改任何决策（emit 监听器，抛错也只记日志）────────────
  // 这是 agent/pre-step 那次崩溃的教训：waterfall 必须 return next()，
  // 所以「说过的哪句话 / 做过哪些事」一律从 emit 的 session/event 取，不碰 pre-step。
  const sessionListener = (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const sid = String((session && session.id) || '')
      const at = Number(event.time) || Date.now()
      const seq = Number(event.seq) || 0
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      if (event.type === 'user/message') {
        const said = textOf(data)
        if (said) appendSession({ at, sid, seq, kind: 'says', text: said })
        return
      }
      if (event.type === 'turn/start') {
        appendSession({ at, sid, seq, kind: 'turn', turn: Number(data.turn) || 0, text: '回合 ' + String(data.turn || '?') + ' 开始' })
        return
      }
      if (event.type === 'tool/call') {
        appendSession({
          at, sid, seq, kind: 'action',
          turn: Number(data.turn) || 0,
          step: Number(data.step) || 0,
          text: String(data.name || '') + ' ' + String(data.arguments || '').replace(/\s+/g, ' ').slice(0, 200),
        })
        return
      }
      if (event.type === 'tool/result') {
        const err = data.error ? '失败 ' + String(data.error.code || data.error.name || '') : '完成'
        appendSession({
          at, sid, seq, kind: 'result',
          turn: Number(data.turn) || 0,
          step: Number(data.step) || 0,
          text: err,
        })
      }
    } catch {
      /* 事件流是旁路，出错绝不影响会话 */
    }
  }

  const SESSION_OPTIONS = { global: true, prepend: true }
  keep(ctx.on('session/event', sessionListener, SESSION_OPTIONS))

  // ── HTTP 接口：给图形化时间轴取数（同源，走宿主自带的 web 服务）────────────
  const send = (res, code, body) => {
    try {
      const text = JSON.stringify(body)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    } catch {
      /* 响应已经结束就算了 */
    }
  }

  const apiHandler = async (req, res) => {
    try {
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
      const sub = url.pathname.replace(/^\/beforewrite\/api/, '') || '/'
      if (sub === '/' || sub === '/ping') {
        return send(res, 200, { ok: true, root: ROOT, version: 'v4' })
      }
      if (sub === '/client-log') {
        // 浏览器里没法看控制台，就让客户端把话写回宿主日志：这是唯一的远端眼睛。
        const m = url.searchParams.get('m') || ''
        debug('CLIENT ' + m.slice(0, 400))
        return send(res, 200, { ok: true })
      }
      if (sub === '/sessions') {
        return send(res, 200, { ok: true, sessions: sessionsSummary() })
      }
      if (sub === '/timeline') {
        const sid = url.searchParams.get('sid') || ''
        return send(res, 200, { ok: true, sid, rows: timelineFor(sid) })
      }
      if (sub === '/diff') {
        const id = Number(url.searchParams.get('id'))
        const fsService = readFs()
        const text = fsService
          ? await runDiff(fsService, readIndex(), { id })
          : '文件系统服务当前不可用。'
        return send(res, 200, { ok: true, text })
      }
      if (sub === '/restore') {
        const id = Number(url.searchParams.get('id'))
        const fsService = readFs()
        if (!fsService) return send(res, 200, { ok: false, text: '文件系统服务当前不可用。' })
        const text = await runRestore(fsService, readIndex(), { id })
        return send(res, 200, { ok: true, text })
      }
      return send(res, 404, { ok: false, text: '没有这个接口：' + sub })
    } catch (error) {
      return send(res, 200, { ok: false, text: '接口内部错误：' + message(error) })
    }
  }

  // webServer 服务在本插件 activate 的那一刻可能还没 provide（实测：apply 时 ctx.get('webServer')
  // 返回 undefined，日志里留下「webServer 服务不可用」）。所以先试一次，拿不到就轮询等它出现，
  // 拿到之后立刻挂载。这是唯一一条能让界面取到数的路。
  let mounted = false
  const mountApi = () => {
    if (mounted) return true
    try {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (!webServer || typeof webServer.register !== 'function') return false
      keep(webServer.register({ kind: 'prefix', path: '/beforewrite/api', handler: apiHandler }))
      mounted = true
      debug('已注册 HTTP 接口 /beforewrite/api')
      return true
    } catch (error) {
      debug('注册 HTTP 接口失败：' + message(error))
      return false
    }
  }

  if (!mountApi()) {
    debug('webServer 尚未就绪，开始轮询等待')
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (mountApi()) return
      if (tries >= 240) {
        clearInterval(timer)
        debug('轮询 240 次（约 2 分钟）仍未拿到 webServer，放弃挂载')
      }
    }, 500)
    if (timer && typeof timer.unref === 'function') timer.unref()
    keep(() => clearInterval(timer))
  }

  console.log('[fs-time-machine] 已启动，仓库目录：' + ROOT)

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时不再追究 */
      }
    }
  }
}
