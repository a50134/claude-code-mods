import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'projects-token-panel'
const NOW = 1_800_000_000_000

const project = (over: Record<string, unknown>) => ({
  key: 'C:\\work\\alpha',
  name: 'alpha',
  title: '重構登入',
  hasFolder: true,
  sessions: 2,
  msgs: 9,
  lastTs: NOW - 60000,
  lastPrompt: '把測試補上',
  lastTool: 'Bash',
  today: 1200,
  week: 5300,
  total: 99000,
  state: 'running',
  note: '正在執行 Bash',
  openTasks: [],
  taskTotal: 0,
  taskDone: 0,
  ...over,
})

const SCAN = {
  now: NOW,
  todayTokens: 1200,
  weekTokens: 5300,
  projects: [
    project({}),
    project({ key: 'C:\\Users\\me#abc', name: '英文影片學習計畫', hasFolder: false, state: 'stalled', note: '做到一半就停了' }),
    project({ key: 'C:\\work\\beta', name: 'beta', state: 'todo', note: '待辦清單還有 2 項', openTasks: ['寫文件', '補測試'], taskTotal: 5, taskDone: 3 }),
    project({ key: 'C:\\work\\betamax', name: 'betamax', sessions: 0, lastTs: 0, state: 'empty', note: '', title: '', lastPrompt: '' }),
  ],
}

const PROPS = {
  title: '專案 & Token',
  isFocused: false,
  bodyColumns: 46,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: typed add, cards, statuses, resize and shrink on ${surface}`, async ($, on) => {
    const opened: Array<Record<string, unknown>> = []
    mock.clock(on, { now: NOW })
    mock.store(on, { watched: ['c:\\work\\alpha'] })
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
    on('session.usage', () => ({ value: {
      startedAt: NOW - 1000,
      context: { window: 200000, tokens: 50000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 3600000).toISOString() }],
    } }))
    on('config.list', () => ({ value: [] }))
    on('ui.open', (_$, e) => {
      opened.push(e as Record<string, unknown>)
      return { value: { isPlaced: true } }
    })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PROPS })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })

    // Only the watched project is drawn; the others are no longer listed.
    const cardsOf = async () => (await ui.findAll({ type: 'Box' })).filter(box => String(box.key ?? '').startsWith('card-'))
    expect(await cardsOf()).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: '進行中' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '英文影片學習計畫' })).toBeUndefined()
    for (const card of await cardsOf()) {
      expect(card.props.borderStyle).toBe('round')
      expect(typeof card.props.backgroundColor).toBe('string')
    }

    // An ambiguous keyword adds nothing and lists the matches.
    await ui.input({ key: 'add', text: 'bet' })
    expect(await cardsOf()).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: '點一下加入' })).toBeDefined()

    // An unknown one says so; ? lists what can be added.
    await ui.input({ key: 'add', text: 'nope' })
    expect(await ui.find({ type: 'Text', text: '找不到跟「nope」有關' })).toBeDefined()
    await ui.input({ key: 'add', text: '?' })
    expect(await ui.find({ type: 'Text', text: '英文影片學習計畫' })).toBeDefined()

    // The exact name adds it, with its open-task status.
    await ui.input({ key: 'add', text: 'beta' })
    expect(await cardsOf()).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: '尚有 2 項未完成' })).toBeDefined()

    const id0 = (await cardsOf()).find(card => card.text.includes('beta'))?.key?.slice(5)
    // A task list drives the bar; without one it is unset until the person sets it.
    expect(await ui.find({ type: 'Text', text: '60%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3/5 項' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '未設定' })).toBeDefined()
    const alpha = (await cardsOf()).find(card => card.text.includes('alpha'))?.key?.slice(5)
    await ui.press({ key: `fold-${alpha}` })
    await ui.press({ key: `more-${alpha}` })
    await ui.press({ key: `more-${alpha}` })
    await ui.press({ key: `less-${alpha}` })
    expect((await ui.find({ key: `prog-${alpha}` }))?.text).toContain('10% 手動')
    expect(await ui.find({ key: `more-${id0}` })).toBeUndefined()
    await ui.press({ key: `fold-${alpha}` })

    // Expand beta: details, open tasks and the per-card controls appear.
    const beta = (await cardsOf()).find(card => card.text.includes('beta'))
    const id = beta?.key?.slice(5)
    expect(await ui.find({ type: 'Text', text: '累計' })).toBeUndefined()
    await ui.press({ key: `fold-${id}` })
    expect(await ui.find({ type: 'Text', text: '累計' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '□ 寫文件' })).toBeDefined()

    // Recolor it, then flip the tone: the fill changes each time.
    const fill = async () => (await ui.find({ key: beta?.key ?? '' }))?.props.backgroundColor
    const first = await fill()
    await ui.press({ key: `color-${id}` })
    const second = await fill()
    expect(second).not.toBe(first)
    await ui.press({ key: 'tone' })
    expect(await fill()).not.toBe(second)

    // Shrink: one line per watched project, cards gone; restore brings them back.
    await ui.press({ key: 'mini' })
    expect(await cardsOf()).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: 'alpha 進行中' })).toBeDefined()
    await ui.press({ key: 'restore' })
    expect(await cardsOf()).toHaveLength(2)

    // Remove beta again.
    await ui.press({ key: `toggle-${id}` })
    expect(await cardsOf()).toHaveLength(1)

    await ui.unmount()
  })
}

test('pane still draws when the scan fails', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'node: not found' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PROPS })
  expect(await ui.find({ type: 'Text', text: '統計失敗' })).toBeDefined()
  await ui.unmount()
})

test('one press adds the project this session belongs to', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: 'C:/Users/me' }))
  on('session.id', () => ({ value: 'abc' }))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PROPS })
  const cardsOf = async () => (await ui.findAll({ type: 'Box' })).filter(box => String(box.key ?? '').startsWith('card-'))
  expect(await cardsOf()).toHaveLength(0)
  await ui.press({ key: 'add-here' })
  const cards = await cardsOf()
  expect(cards).toHaveLength(1)
  expect(cards[0].text).toContain('英文影片學習計畫')
  expect(await ui.find({ key: 'add-here' })).toBeUndefined()
  await ui.unmount()
})
