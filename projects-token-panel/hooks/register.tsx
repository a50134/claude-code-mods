import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'projects-token-panel'
// Shown in the pane's footer, to tell at a glance which build a session has loaded.
const VERSION = '0.5.0'
const tick = atom({ plugin: 'projects-token-panel', key: 'tick' } as const, 0)
const closed = atom({ plugin: 'projects-token-panel', key: 'closed' } as const, false)

const LABELS: Record<string, string> = {
  five_hour: '5小時',
  seven_day: '本週',
  spend_limit: '花費上限',
}

type Tone = 'dark' | 'light'
type State = 'running' | 'waiting' | 'todo' | 'stalled' | 'interrupted' | 'error' | 'stopped' | 'empty'

type Project = {
  key: string
  name: string
  title: string
  titles: string[]
  about?: string
  hasFolder: boolean
  sessions: number
  msgs: number
  lastTs: number
  lastPrompt: string
  lastTool: string
  today: number
  week: number
  total: number
  state: State
  note: string
  openTasks: string[]
  taskTotal: number
  taskDone: number
}
type Scan = { now: number; todayTokens: number; weekTokens: number; projects: Project[] }

// Each hue has a subtle fill and a stronger edge per tone, so text stays readable on it.
const PALETTE = [
  { name: '藍', dark: { bg: '#1e2b4d', edge: '#7aa2f7' }, light: { bg: '#dbe7ff', edge: '#3d6bd6' } },
  { name: '綠', dark: { bg: '#1f3a2a', edge: '#9ece6a' }, light: { bg: '#dff2d0', edge: '#4f8a1f' } },
  { name: '黃', dark: { bg: '#40351a', edge: '#e0af68' }, light: { bg: '#f8ecc8', edge: '#9a6b00' } },
  { name: '紫', dark: { bg: '#33274d', edge: '#bb9af7' }, light: { bg: '#eadcff', edge: '#7a4fd0' } },
  { name: '粉', dark: { bg: '#45222e', edge: '#f7768e' }, light: { bg: '#ffdbe3', edge: '#c93a5a' } },
  { name: '青', dark: { bg: '#173a45', edge: '#7dcfff' }, light: { bg: '#d3f0fb', edge: '#1b7fa8' } },
  { name: '橘', dark: { bg: '#452b18', edge: '#ff9e64' }, light: { bg: '#ffe2cc', edge: '#c25e12' } },
  { name: '灰', dark: { bg: '#2c3040', edge: '#a9b1d6' }, light: { bg: '#e4e7f0', edge: '#5a6078' } },
]

const INK: Record<Tone, { main: string; sub: string }> = {
  dark: { main: '#e6e9f5', sub: '#aab0c8' },
  light: { main: '#1f2335', sub: '#565f89' },
}

const STATUS: Record<State, { glyph: string; label: string; dark: string; light: string }> = {
  running: { glyph: '●', label: '進行中', dark: '#9ece6a', light: '#2f7d14' },
  waiting: { glyph: '◆', label: '等你回覆', dark: '#e0af68', light: '#8a5a00' },
  todo: { glyph: '◐', label: '尚有事項未完成', dark: '#ff9e64', light: '#b3540e' },
  stalled: { glyph: '◐', label: '尚有事項未完成', dark: '#ff9e64', light: '#b3540e' },
  interrupted: { glyph: '✕', label: '已中斷', dark: '#f7768e', light: '#c22f4e' },
  error: { glyph: '✕', label: '出錯停止', dark: '#f7768e', light: '#c22f4e' },
  stopped: { glyph: '■', label: '已停止', dark: '#c0c6de', light: '#5a6078' },
  empty: { glyph: '·', label: '尚無紀錄', dark: '#8f96b3', light: '#7a8099' },
}

let scan: Scan | undefined
let scanAt = 0
let scanError = ''
let autoTone: Tone | undefined
let flash: string[] = []
let picks: string[] = []

function countdown(iso: string | undefined, now: number): string {
  if (!iso) return '未知'
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return '即將重置'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}天${h}時` : `${h}時${m % 60}分`
}

function bar(percent: number, width = 16): string {
  const n = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}

function ago(ts: number, now: number): string {
  if (!ts) return '-'
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}秒前`
  if (s < 3600) return `${Math.floor(s / 60)}分前`
  if (s < 86400) return `${Math.floor(s / 3600)}時前`
  return `${Math.floor(s / 86400)}天前`
}

function tok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

// CJK and full-width characters take two terminal cells.
function cells(ch: string): number {
  return (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1
}

function fit(s: string, max: number): string {
  let total = 0
  for (const ch of s) total += cells(ch)
  if (total <= max) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    if (used + cells(ch) > max - 1) break
    out += ch
    used += cells(ch)
  }
  return `${out}…`
}

function hash(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h
}

function colorIndex(colors: Record<string, number>, key: string): number {
  const saved = colors[key]
  return (typeof saved === 'number' ? saved : hash(key)) % PALETTE.length
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// A task list in the conversation gives the percentage; otherwise it is the one the person set.
function progressOf(p: Project, manual: Record<string, number>): { percent: number | undefined; source: string } {
  if (p.taskTotal > 0) {
    return { percent: Math.round((p.taskDone / p.taskTotal) * 100), source: `${p.taskDone}/${p.taskTotal} 項` }
  }
  const set = manual[p.key.toLowerCase()]
  return typeof set === 'number' ? { percent: set, source: '手動' } : { percent: undefined, source: '未設定' }
}

// A folder project is found by its folder name or by the title of any conversation in it.
// Words that mean the same thing across the Chinese the person types and English folder names.
const SYNONYMS = [
  ['股票', '股', '選股', '台股', 'stock', 'swing', 'breakout', 'trading'],
  ['稅', '報稅', 'tax'],
  ['影片', '視訊', 'video'],
  ['職缺', '工作', '求職', 'job'],
  ['筆記', 'notes', 'note'],
  ['英文', '英語', 'english'],
]

// Exact name first, then a substring of the name, a conversation title or the folder's README,
// then synonyms, then any shared CJK character: a loose match is offered, never added silently.
function findProjects(pool: readonly Project[], keyword: string): Project[] {
  const kw = keyword.trim().toLowerCase()
  if (kw === '') return []
  const names = (p: Project) => [p.name, ...(p.titles ?? [])].map(n => n.toLowerCase())
  const all = (p: Project) => `${names(p).join(' ')} ${(p.about ?? '').toLowerCase()}`
  const exact = pool.filter(p => names(p).includes(kw))
  if (exact.length > 0) return exact
  const named = pool.filter(p => names(p).some(n => n.includes(kw)))
  if (named.length > 0) return named
  const words = [kw, ...SYNONYMS.filter(group => group.some(w => kw.includes(w) || w.includes(kw))).flat()]
  const alike = pool.filter(p => words.some(w => all(p).includes(w)))
  if (alike.length > 0) return alike
  const chars = [...kw].filter(ch => cells(ch) === 2)
  return pool.filter(p => chars.some(ch => names(p).some(n => n.includes(ch))))
}

function describe(p: Project): string {
  const inside = (p.titles ?? []).filter(t => t !== p.name)
  return p.hasFolder && inside.length > 0 ? `${p.name}（對話：${inside.join('、')}）` : p.name
}

const ZH_TW = {
  id: 'projects-token-panel:zh-tw',
  text: '一律使用繁體中文（台灣用語）回覆使用者，包括說明、摘要、提問和進度更新，不要使用簡體中文。程式碼、指令、檔名、識別字，以及使用者明確要求用其他語言寫的內容維持原樣。',
  scope: 'session',
} as const

function statusLabel(p: Project): string {
  return p.state === 'todo' ? `尚有 ${p.openTasks.length} 項未完成` : STATUS[p.state].label
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'projects',
      description: '專案面板：add/remove 關鍵字、list、clear',
    })
    await $.command.register({ name: 'zh', description: '強制繁體中文回覆：/zh on、/zh off，不加參數則切換' })
    void $.ui.open({ id: PANE, title: '專案 & Token' })
    return next(e)
  })

  on('command.run', { command: 'projects' }, async ($, e) => {
    const args = e.args.trim()
    const [verb, ...words] = args.split(/\s+/)
    const keyword = words.join(' ').trim()
    const watched = strings(await $.store.get('watched'))

    if (args === '' || verb === 'open') {
      await update($, closed, () => false)
      await $.ui.open({ id: PANE, title: '專案 & Token' })
      return { text: watched.length === 0 ? '已開啟面板。在想觀察的專案上按「加入」。' : '已開啟專案 & Token 面板' }
    }

    if (verb === 'close') {
      await update($, closed, () => true)
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: '已關閉面板。按輸入框上方的「開啟專案面板」或輸入 /projects 可重開。' }
    }

    let found: Project[] = []
    try {
      const run = await $.process.run(['node', `${$.plugin.root}/scripts/scan.mjs`], { timeoutMs: 60000 })
      if (run.exitCode === 0) found = (JSON.parse(run.stdout) as Scan).projects
    } catch {
      found = []
    }

    if (verb === 'list') {
      if (found.length === 0) return { text: '讀不到專案清單' }
      return {
        text: found
          .map(p => `${watched.includes(p.key.toLowerCase()) ? '[✓]' : '[ ]'} ${describe(p)} — ${statusLabel(p)}`)
          .join('\n'),
      }
    }

    if (verb === 'clear') {
      await $.store.set('watched', [])
      await update($, tick, n => n + 1)
      return { text: '已清空觀察清單' }
    }

    if (verb === 'add' || verb === 'remove') {
      if (keyword === '') return { text: `用法：/projects ${verb} 專案關鍵字（/projects list 可看全部）` }
      const hits = findProjects(found, keyword)
      if (hits.length === 0) return { text: `找不到符合「${keyword}」的專案，/projects list 可看全部` }
      if (hits.length > 1) return { text: `「${keyword}」符合多個，請更精確：\n${hits.map(p => p.name).join('\n')}` }
      const key = hits[0].key.toLowerCase()
      const after = verb === 'add' ? [...new Set([...watched, key])] : watched.filter(k => k !== key)
      await $.store.set('watched', after)
      await update($, tick, n => n + 1)
      return { text: `${verb === 'add' ? '已加入觀察' : '已取消觀察'}：${hits[0].name}（共 ${after.length} 個）` }
    }

    return { text: '用法：/projects [open] | close | add 關鍵字 | remove 關鍵字 | list | clear' }
  })

  on('command.run', { command: 'zh' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : (await $.store.get('zh')) === false
    await $.store.set('zh', isOn)
    await update($, tick, n => n + 1)
    return { text: isOn ? '已開啟：之後一律用繁體中文回覆。' : '已關閉強制繁體中文。' }
  })

  // On unless switched off: every system prompt ends with the Traditional Chinese rule.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await $.store.get('zh')) === false) return composed
    return { sections: [...composed.sections.filter(sec => sec.id !== ZH_TW.id), ZH_TW] }
  })

  // Closing the pane leaves a button above the prompt that opens it again.
  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE) await update($, closed, () => true).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, closed))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button
          key="reopen"
          label="▸ 開啟專案面板"
          onPress={async () => {
            await update($, closed, () => false)
            await $.ui.open({ id: PANE, title: '專案 & Token' })
          }}
        />
        <Text dimColor> 也可以輸入 /projects</Text>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, tick, n => n + 1).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await update($, tick, n => n + 1).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()

    if (!scan || now - scanAt > 10000) {
      try {
        const run = await $.process.run(['node', `${$.plugin.root}/scripts/scan.mjs`], { timeoutMs: 60000 })
        if (run.exitCode === 0) {
          scan = JSON.parse(run.stdout) as Scan
          scanError = ''
        } else {
          scanError = run.stderr.slice(0, 120)
        }
      } catch (err) {
        scanError = String(err).slice(0, 120)
      }
      scanAt = now
    }

    if (autoTone === undefined) {
      try {
        const theme = (await $.config.list()).find(row => row.key === 'theme')
        autoTone = String(theme?.value ?? '').includes('light') ? 'light' : 'dark'
      } catch {
        autoTone = 'dark'
      }
    }

    const usage = await $.session.usage()
    const watched = strings(await $.store.get('watched'))
    const expanded = strings(await $.store.get('expanded'))
    const storedColors = await $.store.get('colors')
    const colors: Record<string, number> =
      storedColors && typeof storedColors === 'object' ? (storedColors as Record<string, number>) : {}
    const storedProgress = await $.store.get('progress')
    const manual: Record<string, number> =
      storedProgress && typeof storedProgress === 'object' ? (storedProgress as Record<string, number>) : {}
    const storedTone = await $.store.get('tone')
    const tone: Tone = storedTone === 'dark' || storedTone === 'light' ? storedTone : autoTone
    const ink = INK[tone]
    const isZh = (await $.store.get('zh')) !== false

    const all = scan?.projects ?? []
    const picked = all.filter(p => watched.includes(p.key.toLowerCase()))
    const others = all.filter(p => !watched.includes(p.key.toLowerCase()))
    const running = picked.filter(p => p.state === 'running').length
    const pending = picked.filter(p => p.state === 'waiting' || p.state === 'todo' || p.state === 'stalled').length
    // The project this session belongs to: its folder, or for a folderless session the folder plus its id.
    const cwd = (await $.session.cwd().catch(() => '')).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const sid = await $.session.id().catch(() => '')
    const here = cwd === '' ? undefined : all.find(p => p.key.toLowerCase() === cwd || p.key.toLowerCase() === `${cwd}#${sid}`)
    const width = e.props.bodyColumns > 0 ? e.props.bodyColumns : 44
    const inner = Math.max(16, width - 4)

    if ((await $.store.get('mini')) === true) {
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text>
              {usage.rateLimits.map(r => `${LABELS[r.kind] ?? r.kind} ${r.percentUsed}%`).join(' · ') || '額度 -'}
            </Text>
            <Button
              key="restore"
              label="還原"
              onPress={async () => {
                await $.store.set('mini', false)
                await $.ui.open({ id: PANE, title: '專案 & Token', rows: 24 })
                await update($, tick, n => n + 1)
              }}
            />
          </Box>
          {picked.map(p => (
            <Box>
              <Text color={STATUS[p.state][tone]}>{STATUS[p.state].glyph} </Text>
              <Text>{fit(`${p.name} ${statusLabel(p)}`, width - 3)}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>用量額度</Text>
        {usage.rateLimits.length === 0 && <Text dimColor>尚無資料（送出一次訊息後更新）</Text>}
        {usage.rateLimits.map(r => (
          <Text>
            {LABELS[r.kind] ?? r.kind} {bar(r.percentUsed)} {r.percentUsed}% · 重置 {countdown(r.resetsAt, now)}
          </Text>
        ))}
        {scan && (
          <Text dimColor>
            全部專案 今日 {tok(scan.todayTokens)} · 近7天 {tok(scan.weekTokens)} tokens
          </Text>
        )}
        <Text dimColor>
          本 session Context {tok(usage.context.tokens ?? 0)}/{tok(usage.context.window)} ({usage.context.percent ?? 0}%)
          {usage.cost ? ` · $${usage.cost.usd.toFixed(2)}` : ''}
        </Text>

        <Box>
          <Button
            key="mini"
            label="縮小"
            onPress={async () => {
              await $.store.set('mini', true)
              await $.ui.open({ id: PANE, title: '專案 & Token', rows: Math.min(12, picked.length + 3) })
              await update($, tick, n => n + 1)
            }}
          />
          <Text> </Text>
          <Button
            key="zh"
            label={isZh ? '繁中:開' : '繁中:關'}
            onPress={async () => {
              await $.store.set('zh', !isZh)
              await update($, tick, n => n + 1)
            }}
          />
          <Text> </Text>
          <Button
            key="tone"
            label={tone === 'dark' ? '底色:深' : '底色:淺'}
            onPress={async () => {
              await $.store.set('tone', tone === 'dark' ? 'light' : 'dark')
              await update($, tick, n => n + 1)
            }}
          />
        </Box>
        <Text bold>
          觀察中 {picked.length}/{all.length} · 進行中 {running} · 待處理 {pending}
        </Text>
        {scanError !== '' && <Text color="red">統計失敗：{scanError}</Text>}
        {picked.length === 0 && all.length > 0 && <Text dimColor>還沒選專案，在下方輸入名稱加入。</Text>}

        {picked.map(p => {
          const k = p.key.toLowerCase()
          const id = hash(k).toString(36)
          const isOpen = expanded.includes(k)
          const hue = PALETTE[colorIndex(colors, k)]
          const tint = hue[tone]
          const st = STATUS[p.state]
          const prog = progressOf(p, manual)
          const barWidth = Math.max(8, Math.min(20, inner - 18))

          return (
            <Box
              key={`card-${id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={tint.edge}
              backgroundColor={tint.bg}
              paddingX={1}
            >
              <Box justifyContent="space-between">
                <Text bold color={tint.edge}>
                  {fit(p.name, inner - 8)}
                </Text>
                <Button
                  key={`fold-${id}`}
                  plain
                  label={isOpen ? '▴ 收合' : '▾ 展開'}
                  onPress={async () => {
                    const cur = strings(await $.store.get('expanded'))
                    await $.store.set('expanded', cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k])
                    await update($, tick, n => n + 1)
                  }}
                />
              </Box>
              <Box>
                <Text bold color={st[tone]}>
                  {st.glyph} {statusLabel(p)}
                </Text>
                {p.lastTs > 0 && <Text color={ink.sub}> · {ago(p.lastTs, now)}</Text>}
              </Box>
              {p.hasFolder && (p.titles ?? []).length > 0 && (
                <Text color={ink.sub}>{fit(`對話：${p.titles.join('、')}`, inner)}</Text>
              )}
              <Box key={`prog-${id}`}>
                <Text color={tint.edge}>進度 {bar(prog.percent ?? 0, barWidth)}</Text>
                <Text color={ink.main}> {prog.percent === undefined ? '' : `${prog.percent}% `}</Text>
                <Text color={ink.sub}>{prog.source}</Text>
              </Box>
              {isOpen && p.note !== '' && <Text color={ink.main}>{fit(p.note, inner)}</Text>}
              {isOpen && p.openTasks.slice(0, 3).map(t => <Text color={ink.main}>{fit(`□ ${t}`, inner)}</Text>)}
              {isOpen && p.sessions > 0 && (
                <Text color={ink.sub}>
                  {p.sessions}場 {p.msgs}則 · 今日{tok(p.today)} 7天{tok(p.week)} 累計{tok(p.total)}
                </Text>
              )}
              {isOpen && p.lastPrompt !== '' && <Text color={ink.sub}>{fit(`最後提問：${p.lastPrompt}`, inner)}</Text>}
              {isOpen && p.taskTotal === 0 && (
                <Box>
                  <Button
                    key={`less-${id}`}
                    label="進度－10"
                    onPress={async () => {
                      const cur = await $.store.get('progress')
                      const map = cur && typeof cur === 'object' ? (cur as Record<string, number>) : {}
                      await $.store.set('progress', { ...map, [k]: Math.max(0, (map[k] ?? 0) - 10) })
                      await update($, tick, n => n + 1)
                    }}
                  />
                  <Text> </Text>
                  <Button
                    key={`more-${id}`}
                    label="進度＋10"
                    onPress={async () => {
                      const cur = await $.store.get('progress')
                      const map = cur && typeof cur === 'object' ? (cur as Record<string, number>) : {}
                      await $.store.set('progress', { ...map, [k]: Math.min(100, (map[k] ?? 0) + 10) })
                      await update($, tick, n => n + 1)
                    }}
                  />
                </Box>
              )}
              {isOpen && (
                <Box>
                  <Button
                    key={`color-${id}`}
                    label={`色:${hue.name}`}
                    onPress={async () => {
                      const cur = await $.store.get('colors')
                      const map = cur && typeof cur === 'object' ? (cur as Record<string, number>) : {}
                      await $.store.set('colors', { ...map, [k]: (colorIndex(map, k) + 1) % PALETTE.length })
                      await update($, tick, n => n + 1)
                    }}
                  />
                  <Text> </Text>
                  <Button
                    key={`toggle-${id}`}
                    label="移除"
                    onPress={async () => {
                      const cur = strings(await $.store.get('watched'))
                      await $.store.set('watched', cur.filter(x => x !== k))
                      await update($, tick, n => n + 1)
                    }}
                  />
                </Box>
              )}
            </Box>
          )
        })}

        {here !== undefined && !watched.includes(here.key.toLowerCase()) && (
          <Box>
            <Button
              key="add-here"
              variant="primary"
              label="＋加入目前專案"
              onPress={async () => {
                const cur = strings(await $.store.get('watched'))
                await $.store.set('watched', [...new Set([...cur, here.key.toLowerCase()])])
                flash = [`已加入：${here.name}`]
                await update($, tick, n => n + 1)
              }}
            />
            <Text dimColor> {fit(here.name, inner - 16)}</Text>
          </Box>
        )}
        <Input
          key="add"
          label="加入專案"
          placeholder="輸入專案或對話名稱，? 列出全部"
          submitLabel="加入"
          value=""
          onSubmit={async value => {
            const kw = value.trim().toLowerCase()
            if (kw === '') return
            if (kw === '?' || kw === '？') {
              flash = ['可加入的專案：', ...others.map(p => `  ${describe(p)}`)]
            } else {
              const hits = findProjects(others, kw)
              const isSure = hits.length === 1 && [hits[0].name, ...(hits[0].titles ?? [])].some(n => n.toLowerCase().includes(kw))
              picks = []
              if (isSure) {
                const cur = strings(await $.store.get('watched'))
                await $.store.set('watched', [...new Set([...cur, hits[0].key.toLowerCase()])])
                flash = [`已加入：${describe(hits[0])}`]
              } else if (hits.length === 0) {
                flash = [`找不到跟「${value.trim()}」有關的專案，輸入 ? 可列出全部`]
              } else {
                flash = [`跟「${value.trim()}」有關的專案，點一下加入：`]
                picks = hits.slice(0, 8).map(p => p.key.toLowerCase())
              }
            }
            if (kw === '?' || kw === '？') picks = []
            await update($, tick, n => n + 1)
          }}
        />
        {flash.map(line => (
          <Text dimColor>{fit(line, inner + 2)}</Text>
        ))}
        {others
          .filter(p => picks.includes(p.key.toLowerCase()))
          .map(p => (
            <Box flexDirection="column">
              <Button
                key={`pick-${hash(p.key.toLowerCase()).toString(36)}`}
                label={`＋ ${fit(p.name, inner - 6)}`}
                onPress={async () => {
                  const cur = strings(await $.store.get('watched'))
                  await $.store.set('watched', [...new Set([...cur, p.key.toLowerCase()])])
                  picks = picks.filter(k => k !== p.key.toLowerCase())
                  flash = [`已加入：${p.name}`]
                  await update($, tick, n => n + 1)
                }}
              />
              {(p.about ?? '') !== '' && <Text dimColor>{fit(`   ${p.about}`, inner + 2)}</Text>}
            </Box>
          ))}

        <Text dimColor>● 進行中 ◆ 等你回覆 ◐ 未完成 ✕ 中斷/出錯 ■ 已停止 · 無紀錄</Text>
        <Text dimColor>點一下面板後，用滾輪或方向鍵上下捲動。</Text>
        <Text dimColor>來源：本機對話紀錄（不含子代理）。tokens＝輸入+輸出+快取寫入。</Text>
        <Text dimColor>面板版本 {VERSION}</Text>
      </Box>
    )
  })
}
