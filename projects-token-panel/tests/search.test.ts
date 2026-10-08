import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'projects-token-panel'
const NOW = 1_800_000_000_000
const folder = (name: string, about: string) => ({
  key: `C:/work/${name}`,
  name,
  title: '',
  titles: [],
  about,
  hasFolder: true,
  sessions: 0,
  msgs: 0,
  lastTs: 0,
  lastPrompt: '',
  lastTool: '',
  today: 0,
  week: 0,
  total: 0,
  state: 'empty',
  note: '',
  openTasks: [],
  taskTotal: 0,
  taskDone: 0,
})
const SCAN = {
  now: NOW,
  todayTokens: 0,
  weekTokens: 0,
  projects: [
    folder('條件選股室', '條件選股室每日自動報告'),
    folder('stock-analysis-lab', '台股研究分析實驗室 分析上市、上櫃股票的公開歷史市場資料'),
    folder('breakout-swing', ''),
    folder('tax-calculator', '綜所稅試算器'),
  ],
}
const PROPS = {
  title: '專案 & Token',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a loose keyword offers related projects to click on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
    on('config.list', () => ({ value: [] }))

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PROPS })
    const cardsOf = async () => (await ui.findAll({ type: 'Box' })).filter(box => String(box.key ?? '').startsWith('card-'))
    const picksOf = async () => (await ui.findAll({ type: 'Button' })).filter(b => String(b.key ?? '').startsWith('pick-'))

    // 股票 is in no name: the three stock projects are offered, the tax one is not, nothing is added.
    await ui.input({ key: 'add', text: '股票' })
    expect(await cardsOf()).toHaveLength(0)
    const offered = await picksOf()
    expect(offered.map(b => b.text).sort()).toEqual(['＋ breakout-swing', '＋ stock-analysis-lab', '＋ 條件選股室'])

    // Clicking one adds it and leaves the other offers up.
    await ui.press({ key: offered.find(b => b.text.includes('條件選股室'))?.key ?? '' })
    expect((await cardsOf())[0].text).toContain('條件選股室')
    expect(await picksOf()).toHaveLength(2)

    // A keyword that names exactly one project still adds it straight away.
    await ui.input({ key: 'add', text: 'tax' })
    expect(await cardsOf()).toHaveLength(2)
    expect(await picksOf()).toHaveLength(0)
    await ui.unmount()
  })
}
