import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'projects-token-panel'
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`closing the pane leaves a button that reopens it on ${surface}`, async ($, on) => {
    const opened: string[] = []
    mock.store(on)
    on('ui.close', () => ({ value: undefined }))
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

    // While the pane is open the band shows nothing of ours.
    const before = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect(await before.find({ key: 'reopen' })).toBeUndefined()
    await before.unmount()

    // Closing ours brings the button.
    await $.command.run({ command: 'projects', args: 'close' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'reopen' }))?.text).toContain('開啟專案面板')

    // Pressing it opens the pane and the button goes away.
    await ui.press({ key: 'reopen' })
    expect(opened).toEqual([PLUGIN])
    expect(await ui.find({ key: 'reopen' })).toBeUndefined()
    await ui.unmount()
  })
}
