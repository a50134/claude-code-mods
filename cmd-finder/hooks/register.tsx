import { atom, read, update } from 'claude-code'
import type { CommandInfo, Register } from 'claude-code'

const PANE = 'cmd-finder'
const TITLE = '查指令 / skill'
const query = atom({ plugin: 'cmd-finder', key: 'query' } as const, '')

const SOURCE: Record<string, string> = {
  builtin: '內建',
  plugin: '外掛',
  user: '自訂',
  mcp: 'MCP',
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

function tag(c: CommandInfo): string {
  const from = SOURCE[c.source] ?? c.source
  return c.plugin ? `${from}:${c.plugin}` : from
}

// Every word must appear; a hit in the name ranks above one in the description.
function search(list: readonly CommandInfo[], q: string): CommandInfo[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...list]
  const hits: Array<{ c: CommandInfo; rank: number }> = []
  for (const c of list) {
    const name = c.name.toLowerCase()
    const all = `${name} ${c.description} ${c.plugin ?? ''}`.toLowerCase()
    if (!words.every(w => all.includes(w))) continue
    hits.push({ c, rank: name === words[0] ? 0 : name.startsWith(words[0]) ? 1 : name.includes(words[0]) ? 2 : 3 })
  }
  return hits.sort((a, b) => a.rank - b.rank).map(h => h.c)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'find',
      description: '查指令和 skill：/find 關鍵字',
    })
    return next(e)
  })

  on('command.run', { command: 'find' }, async ($, e) => {
    const q = e.args.trim()
    await update($, query, () => q)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    const found = search(await $.command.list(), q)
    if (q === '') return { text: `共 ${found.length} 個指令和 skill，已開啟搜尋面板。` }
    if (found.length === 0) return { text: `找不到符合「${q}」的指令或 skill。` }
    const lines = found.slice(0, 15).map(c => `/${c.name} — ${c.description} [${tag(c)}]`)
    const more = found.length > 15 ? `\n…還有 ${found.length - 15} 個，請看面板或加關鍵字` : ''
    return { text: `符合「${q}」的有 ${found.length} 個：\n${lines.join('\n')}${more}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const q = await read($, query)
    const width = e.props.bodyColumns > 0 ? e.props.bodyColumns : 48
    let list: CommandInfo[] = []
    let failure = ''
    try {
      list = await $.command.list()
    } catch (err) {
      failure = String(err).slice(0, 100)
    }
    const found = search(list, q)
    const shown = found.slice(0, 40)

    return (
      <Box flexDirection="column">
        <Input
          key="q"
          label="搜尋"
          placeholder="輸入關鍵字，可用空格分開多個"
          submitLabel="搜尋"
          value={q}
          autoFocus
          onInput={value => update($, query, () => value)}
          onSubmit={value => update($, query, () => value)}
        />
        {failure !== '' && <Text color="red">讀不到指令清單：{failure}</Text>}
        <Text dimColor>
          {q === '' ? `共 ${list.length} 個` : `符合 ${found.length} / ${list.length} 個`}
          {found.length > shown.length ? `，顯示前 ${shown.length} 個` : ''} · 點名稱會填進輸入框
        </Text>
        {shown.map(c => (
          <Box flexDirection="column">
            <Box>
              <Button
                key={`c-${c.name.replace(/[^A-Za-z0-9_-]/g, '_')}`}
                plain
                label={`/${c.name}`}
                onPress={async () => {
                  await $.prompt.fill({ text: `/${c.name} ` })
                }}
              />
              <Text dimColor> [{tag(c)}]</Text>
            </Box>
            <Text dimColor>{fit(`  ${c.description}`, width)}</Text>
          </Box>
        ))}
        {found.length === 0 && failure === '' && <Text dimColor>沒有符合的指令或 skill。</Text>}
      </Box>
    )
  })
}
