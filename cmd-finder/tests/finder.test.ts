import { expect, test } from 'claude-code/testing'

const PLUGIN = 'cmd-finder'
const COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary', source: 'builtin' },
  { name: 'engineering:debug', description: 'Structured debugging session', source: 'plugin', plugin: 'engineering' },
  { name: 'tw-stock-research', description: '台股個股研究流程', source: 'user' },
  { name: 'debug-notes', description: 'notes', source: 'user' },
]
const PROPS = {
  title: '查指令 / skill',
  isFocused: true,
  bodyColumns: 50,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`finder filters and fills the prompt on ${surface}`, async ($, on) => {
    const filled: string[] = []
    on('command.list', () => ({ value: COMMANDS }))
    on('prompt.fill', (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PROPS })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)

    await ui.input({ key: 'q', text: 'debug', kind: 'change' })
    const hits = await ui.findAll({ type: 'Button' })
    expect(hits.map(b => b.text)).toEqual(['/debug-notes', '/engineering:debug'])

    await ui.input({ key: 'q', text: '台股' })
    expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['/tw-stock-research'])
    await ui.press({ key: 'c-tw-stock-research' })
    expect(filled).toEqual(['/tw-stock-research '])

    await ui.input({ key: 'q', text: 'zzz' })
    expect(await ui.find({ type: 'Text', text: '沒有符合' })).toBeDefined()
    await ui.unmount()
  })
}
