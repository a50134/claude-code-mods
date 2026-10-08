import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'token-saver'
const NOW = 1_800_000_000_000
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const usage = (percent: number) => ({
  value: {
    startedAt: NOW,
    context: { window: 200000, tokens: 1000, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: new Date(NOW + 1800000).toISOString() }],
  },
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`asks to save when the limit is nearly used on ${surface}`, async ($, on) => {
    const submitted: string[] = []
    let percent = 40
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('session.usage', () => usage(percent))
    on('session.cwd', () => ({ value: 'C:\\work\\alpha' }))
    on('prompt.submit', (_$, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

    // Below the threshold nothing is raised.
    await $.command.run({ command: 'checkpoint', args: 'check' })
    const quiet = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await quiet.find({ type: 'Button' })).toBeUndefined()
    await quiet.unmount()

    // Past it, the band asks and offers the three answers.
    percent = 90
    await $.command.run({ command: 'checkpoint', args: 'check' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: '額度已用 90%' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)

    // Saving submits the checkpoint prompt with the file path, and the band clears.
    await ui.press({ key: 'save-later' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('C:\\work\\alpha/.claude/checkpoint.md')
    expect(submitted[0]).toContain('下一步')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()

    // The same window is not asked about twice.
    await $.command.run({ command: 'checkpoint', args: 'check' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })
}
