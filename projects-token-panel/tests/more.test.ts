import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'projects-token-panel'
const NOW = 1_800_000_000_000
const SCAN = {
  now: NOW,
  todayTokens: 0,
  weekTokens: 0,
  projects: [
    {
      key: 'C:/work/job-search-site',
      name: 'job-search-site',
      title: 'Security review',
      titles: ['職缺搜尋工具', 'Security review'],
      hasFolder: true,
      sessions: 2,
      msgs: 9,
      lastTs: NOW - 60000,
      lastPrompt: 'x',
      lastTool: '',
      today: 0,
      week: 0,
      total: 10,
      state: 'stopped',
      note: '',
      openTasks: [],
      taskTotal: 0,
      taskDone: 0,
    },
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

test('a folder project is found by the title of a conversation in it', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PLUGIN, props: PROPS })
  await ui.input({ key: 'add', text: '職缺搜尋' })
  const cards = (await ui.findAll({ type: 'Box' })).filter(box => String(box.key ?? '').startsWith('card-'))
  expect(cards).toHaveLength(1)
  expect(cards[0].text).toContain('job-search-site')
  expect(cards[0].text).toContain('對話：職缺搜尋工具、Security review')
  await ui.unmount()
})

const FACTS = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

test('the Traditional Chinese rule is in the system prompt until switched off', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] } }))
  on('config.list', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are helpful.', scope: 'shared' }] }))

  const first = await $.prompt.compose(FACTS)
  expect(first.sections.map(sec => sec.id)).toEqual(['base', 'projects-token-panel:zh-tw'])
  expect(first.sections[1].text).toContain('繁體中文')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: PROPS })
  expect((await ui.find({ key: 'zh' }))?.text).toContain('繁中:開')
  await ui.press({ key: 'zh' })
  expect((await ui.find({ key: 'zh' }))?.text).toContain('繁中:關')
  expect((await $.prompt.compose(FACTS)).sections.map(sec => sec.id)).toEqual(['base'])

  await $.command.run({ command: 'zh', args: 'on' })
  expect((await $.prompt.compose(FACTS)).sections).toHaveLength(2)
  await ui.unmount()
})
