import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const HOME = os.homedir()
// PTP_ROOT / PTP_DESK point the scan at a fixture folder; the cache is skipped then.
const ROOT = process.env.PTP_ROOT || path.join(HOME, '.claude', 'projects')
const DESK = process.env.PTP_DESK ?? path.join(HOME, 'Desktop', 'Claude-project')
const CACHE = process.env.PTP_ROOT ? '' : path.join(os.tmpdir(), 'projects-token-panel-cache-v5.json')
const FRESH_MS = 5 * 60000

const pad = n => String(n).padStart(2, '0')
const day = ts => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n)
const isNoise = text =>
  text.startsWith('<system-reminder>') ||
  text.startsWith('<local-command') ||
  text.startsWith('<command-name>') ||
  text.startsWith('[SYSTEM')

let cache = {}
if (CACHE) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  } catch {}
}

async function scanFile(file) {
  const seen = new Map()
  let cwd, sessionId, msgs = 0, lastTs = 0, firstTs = 0
  let lastPrompt = '', firstPrompt = '', lastTool = '', customTitle = '', aiTitle = ''
  // turn: none | open (model still owes work) | done | interrupted
  let turn = 'none', lastKind = '', pendingTool = '', hadError = false
  let todos = []
  const tasks = new Map()
  const creating = new Map()
  const cwds = new Set()

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0
    if (ts) {
      lastTs = Math.max(lastTs, ts)
      if (!firstTs) firstTs = ts
    }
    if (o.cwd) {
      cwd = o.cwd
      cwds.add(o.cwd)
    }
    sessionId ??= o.sessionId
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle.trim()
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle.trim()
    if (o.isSidechain) continue
    const m = o.message

    if (o.type === 'user' && m) {
      const blocks = Array.isArray(m.content) ? m.content : []
      const results = blocks.filter(b => b.type === 'tool_result')
      for (const b of results) {
        const subject = creating.get(b.tool_use_id)
        if (subject === undefined) continue
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map(x => x.text ?? '').join(' ')
        const id = /#(\d+)/.exec(text)?.[1] ?? /"id"\s*:\s*"?([\w-]+)/.exec(text)?.[1] ?? `t${tasks.size + 1}`
        tasks.set(id, { subject, status: 'pending' })
        creating.delete(b.tool_use_id)
      }
      if (results.length > 0) {
        turn = 'open'
        lastKind = 'tool_result'
        pendingTool = ''
      }
      const text = typeof m.content === 'string' ? m.content : blocks.find(b => b.type === 'text' && !isNoise(b.text))?.text
      if (text && text.startsWith('[Request interrupted')) {
        turn = 'interrupted'
      } else if (text && !isNoise(text) && !o.isMeta) {
        msgs++
        lastPrompt = oneLine(text, 40)
        firstPrompt ||= lastPrompt
        turn = 'open'
        lastKind = 'prompt'
        pendingTool = ''
        hadError = false
      }
    } else if (o.type === 'assistant' && m) {
      if (m.usage) seen.set(m.id ?? o.uuid, { ts, u: m.usage })
      hadError = false
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_use') continue
        lastTool = b.name
        pendingTool = b.name
        lastKind = 'tool_use'
        const input = b.input ?? {}
        if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          todos = input.todos
        } else if (b.name === 'TaskCreate') {
          creating.set(b.id, oneLine(input.subject ?? input.description ?? '待辦', 40))
        } else if (b.name === 'TaskUpdate' && input.taskId != null) {
          const id = String(input.taskId)
          const task = tasks.get(id)
          if (input.status === 'deleted') tasks.delete(id)
          else if (task && input.status) task.status = input.status
        }
      }
      const stop = m.stop_reason
      if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'refusal') {
        turn = 'done'
        pendingTool = ''
        lastKind = 'text'
      } else {
        turn = 'open'
      }
    } else if (o.type === 'system' && o.subtype === 'api_error') {
      hadError = true
    }
  }

  const days = {}
  let io = 0
  for (const { ts, u } of seen.values()) {
    const d = day(ts || lastTs)
    const own = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    days[d] = (days[d] ?? 0) + own
    io += own
  }
  const openTasks = [
    ...todos.filter(t => t && t.status !== 'completed').map(t => oneLine(t.content ?? t.subject ?? '', 40)),
    ...[...tasks.values()].filter(t => t.status !== 'completed').map(t => t.subject),
  ].filter(Boolean)
  const taskTotal = todos.filter(Boolean).length + tasks.size
  const taskDone =
    todos.filter(t => t && t.status === 'completed').length + [...tasks.values()].filter(t => t.status === 'completed').length

  return {
    cwd, sessionId, msgs, lastTs, firstTs, lastPrompt, firstPrompt, lastTool,
    title: customTitle || aiTitle, days, io, turn, lastKind, pendingTool, hadError, openTasks, taskTotal, taskDone, cwds: [...cwds],
  }
}

function statusOf(r, now) {
  if (!r || r.turn === 'none') return { state: 'empty', note: '' }
  const tool = r.pendingTool
  if (r.turn === 'open') {
    if (tool === 'AskUserQuestion') return { state: 'waiting', note: '有問題等你回答' }
    if (tool === 'ExitPlanMode') return { state: 'waiting', note: '計畫等你核准' }
    if (now - r.lastTs < FRESH_MS) return { state: 'running', note: tool ? `正在執行 ${tool}` : '正在處理你的訊息' }
    if (r.hadError) return { state: 'error', note: 'API 出錯後沒有繼續' }
    if (r.lastKind === 'prompt') return { state: 'stalled', note: '你最後的訊息還沒被回覆' }
    return { state: 'stalled', note: tool ? `做到一半停在 ${tool}` : '做到一半就停了' }
  }
  if (r.turn === 'interrupted') return { state: 'interrupted', note: '上一輪被你中斷' }
  if (r.openTasks.length > 0) return { state: 'todo', note: `待辦清單還有 ${r.openTasks.length} 項` }
  return { state: 'stopped', note: '上一輪已回覆完畢' }
}

const results = []
const next = {}
for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const dp = path.join(ROOT, dir.name)
  for (const f of fs.readdirSync(dp)) {
    if (!f.endsWith('.jsonl')) continue
    const fp = path.join(dp, f)
    const st = fs.statSync(fp)
    let r = cache[fp]
    if (!r || r.mtimeMs !== st.mtimeMs || r.size !== st.size) {
      r = { mtimeMs: st.mtimeMs, size: st.size, data: await scanFile(fp) }
    }
    next[fp] = r
    if (r.data.msgs > 0 || r.data.io > 0) results.push({ file: f, ...r.data })
  }
}
if (CACHE) {
  try {
    fs.writeFileSync(CACHE, JSON.stringify(next))
  } catch {}
}

const now = Date.now()
const today = day(now)
const weekDays = new Set()
for (let i = 0; i < 7; i++) weekDays.add(day(now - i * 86400000))

const norm = p =>
  String(p)
    .replace(/^\/([a-z])\//i, '$1:/')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .replace(/^[a-z]:/, c => c.toUpperCase())
const homeKey = norm(HOME).toLowerCase()
const isTemp = d => /\\(scratch-workspaces|scratchpad)(\\|$)|\\AppData\\Local\\Temp(\\|$)/i.test(d)
const roots = new Map()
function repoRoot(dir) {
  if (roots.has(dir)) return roots.get(dir)
  let found = dir
  for (let at = dir; at.toLowerCase() !== homeKey; ) {
    if (fs.existsSync(path.join(at, '.git'))) {
      found = at
      break
    }
    const up = path.win32.dirname(at)
    if (up === at) break
    at = up
  }
  roots.set(dir, found)
  return found
}
const blank = (key, name, hasFolder) => ({
  key, name, title: '', titles: [], hasFolder, sessions: 0, msgs: 0, lastTs: 0, firstTs: 0,
  lastPrompt: '', lastTool: '', today: 0, week: 0, total: 0, state: 'empty', note: '', openTasks: [], taskTotal: 0, taskDone: 0,
})

const opened = new Set(results.filter(r => r.cwd && !isTemp(norm(r.cwd))).map(r => norm(r.cwd).toLowerCase()))
const projects = new Map()
const latest = new Map()
for (const r of results) {
  let dir = r.cwd ? norm(r.cwd) : ''
  // A session that wandered into a subfolder still belongs to the repository around it,
  // or failing that to the nearest folder above that other sessions were opened in.
  if (dir !== '' && !isTemp(dir)) {
    dir = repoRoot(dir)
    for (let at = path.win32.dirname(dir); at.toLowerCase() !== homeKey && at !== path.win32.dirname(at); at = path.win32.dirname(at)) {
      if (opened.has(at.toLowerCase())) {
        dir = at
        break
      }
    }
  }
  const isScratch = /\\scratch-workspaces\\/i.test(dir) && !/\\scratchpad(\\|$)/i.test(dir)
  const hasFolder = dir !== '' && !isTemp(dir) && dir.toLowerCase() !== homeKey
  // A session with no project folder is its own entry, named by its title.
  const key = hasFolder || isScratch ? dir : `${dir || 'session'}#${r.sessionId ?? r.file}`
  let p = projects.get(key)
  if (!p) {
    p = blank(key, '', hasFolder)
    projects.set(key, p)
  }
  p.sessions++
  p.msgs += r.msgs
  p.total += r.io
  if (r.title && !p.titles.includes(r.title)) p.titles.push(r.title)
  p.firstTs = Math.min(p.firstTs || r.firstTs, r.firstTs || p.firstTs)
  for (const [d, v] of Object.entries(r.days)) {
    if (d === today) p.today += v
    if (weekDays.has(d)) p.week += v
  }
  if (r.lastTs >= p.lastTs) {
    p.lastTs = r.lastTs
    p.lastPrompt = r.lastPrompt
    p.lastTool = r.lastTool
    p.title = r.title || p.title || r.firstPrompt.slice(0, 20)
    latest.set(key, r)
  }
}

for (const p of projects.values()) {
  p.name = p.hasFolder ? path.win32.basename(p.key) : p.title || `未命名對話 ${day(p.firstTs || p.lastTs)}`
  const r = latest.get(p.key)
  Object.assign(p, statusOf(r, now))
  p.openTasks = (r?.openTasks ?? []).slice(0, 5)
  p.taskTotal = r?.taskTotal ?? 0
  p.taskDone = r?.taskDone ?? 0
}

if (DESK) {
  try {
    const known = new Set([...projects.keys()].map(k => k.toLowerCase()))
    for (const d of fs.readdirSync(DESK, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const key = norm(path.join(DESK, d.name))
      if (!known.has(key.toLowerCase())) projects.set(key, blank(key, d.name, true))
    }
  } catch {}
}

// The folder's own description, so a project can be found by what it is about.
for (const p of projects.values()) {
  if (!p.hasFolder) continue
  for (const file of ['README.md', 'CLAUDE.md', 'README.txt', 'package.json']) {
    try {
      const text = fs.readFileSync(path.join(p.key, file), 'utf8').slice(0, 1500)
      const body = file === 'package.json' ? String(JSON.parse(text).description ?? '') : text.replace(/[#*`>|_-]+/g, ' ')
      p.about = oneLine(body, 200)
      if (p.about) break
    } catch {}
  }
}

const byName = new Map()
for (const p of projects.values()) byName.set(p.name, (byName.get(p.name) ?? 0) + 1)
for (const p of projects.values()) {
  if (byName.get(p.name) > 1 && (p.firstTs || p.lastTs)) {
    const d = new Date(p.firstTs || p.lastTs)
    p.name = `${p.name} (${pad(d.getMonth() + 1)}/${pad(d.getDate())})`
  }
}

let todayTokens = 0, weekTokens = 0
for (const p of projects.values()) {
  todayTokens += p.today
  weekTokens += p.week
}
const list = [...projects.values()].sort((a, b) => b.lastTs - a.lastTs)
process.stdout.write(JSON.stringify({ now, todayTokens, weekTokens, projects: list }))
