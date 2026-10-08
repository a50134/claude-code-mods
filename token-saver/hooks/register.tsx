import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SaverAsk, SaverResume } from '../types'

const ask = atom({ plugin: 'token-saver', key: 'ask' } as const, null as SaverAsk)
const resume = atom({ plugin: 'token-saver', key: 'resume' } as const, null as SaverResume)

// Percent used at which to ask, per rate-limit window.
const DEFAULTS: Record<string, number> = { five_hour: 85, seven_day: 95 }
const LABELS: Record<string, string> = { five_hour: '5小時', seven_day: '本週' }

let turnId: string | undefined
const asked = new Set<string>()

function checkpointPath(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}/.claude/checkpoint.md`
}

function savePrompt(file: string): string {
  return [
    '額度快用完了。請先停下原本的工作，現在只做一件事：把目前進度寫進暫存檔，讓下次可以接著做。',
    `暫存檔路徑：${file}（已存在就覆寫）`,
    '用繁體中文，依序寫這幾段：',
    '1. 原始目標：使用者要完成什麼',
    '2. 已完成：做完的事，附檔案路徑',
    '3. 做到一半：正在改但還沒完成的東西，寫清楚停在哪',
    '4. 下一步：還沒做的事，照順序列出，具體到可以直接動手',
    '5. 注意事項：踩過的坑、不能動的東西、使用者的偏好',
    '寫完後只用一句話回報已暫存，不要繼續做其他事。',
  ].join('\n')
}

function resumePrompt(file: string): string {
  return [
    `請讀取上次的暫存檔 ${file}，照裡面的「下一步」接著把沒做完的工作做完。`,
    '開始前先用兩三句話說明你要接著做什麼。全部完成後，把暫存檔內容改成一行「已完成」。',
  ].join('\n')
}

function countdown(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return '即將重置'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}天${h}時後重置` : `${h}時${m % 60}分後重置`
}

function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.floor((now - ts) / 60000))
  if (m < 60) return `${m}分前`
  if (m < 1440) return `${Math.floor(m / 60)}時前`
  return `${Math.floor(m / 1440)}天前`
}

async function thresholds($: EngineInterface): Promise<Record<string, number>> {
  const stored = await $.store.get('thresholds')
  return { ...DEFAULTS, ...(stored && typeof stored === 'object' ? (stored as Record<string, number>) : {}) }
}

// Raises the question once per rate-limit window that crosses its threshold.
async function check($: EngineInterface): Promise<boolean> {
  const usage = await $.session.usage()
  const limits = await thresholds($)
  for (const r of usage.rateLimits) {
    const limit = limits[r.kind]
    if (limit === undefined || r.percentUsed < limit) continue
    const id = `${r.kind}|${r.resetsAt ?? ''}`
    if (asked.has(id)) continue
    asked.add(id)
    await update($, ask, () => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt }))
    $.ui.toast(`${LABELS[r.kind] ?? r.kind}額度已用 ${r.percentUsed}%，要暫存進度嗎？`)
    return true
  }
  return false
}

async function save($: EngineInterface, abort: boolean): Promise<string> {
  if (abort && turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined)
  const file = checkpointPath(await $.session.cwd())
  void $.prompt.submit({ text: savePrompt(file) }).catch(() => undefined)
  await update($, ask, () => null)
  return file
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checkpoint',
      description: '暫存進度：save（預設）、resume、check、threshold 數字、status',
    })
    const file = checkpointPath(e.cwd)
    if (await $.fs.exists(file)) {
      const stat = await $.fs.stat(file)
      const dismissed = await $.store.get('dismissed')
      const seen = dismissed && typeof dismissed === 'object' ? (dismissed as Record<string, number>)[file] : undefined
      const text = stat.size < 200 ? await $.fs.read(file) : ''
      if (seen !== stat.mtimeMs && text.trim() !== '已完成') {
        await update($, resume, () => ({ file, savedAt: stat.mtimeMs }))
      }
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    turnId = undefined
    await check($).catch(() => false)
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await check($).catch(() => false)
    return ran
  })

  on('command.run', { command: 'checkpoint' }, async ($, e) => {
    const [verb = 'save', value] = e.args.trim().split(/\s+/).filter(Boolean)

    if (verb === 'save') {
      const file = await save($, false)
      return { text: `這一輪結束後會把進度暫存到 ${file}` }
    }
    if (verb === 'resume') {
      const file = checkpointPath(await $.session.cwd())
      if (!(await $.fs.exists(file))) return { text: `沒有暫存檔（${file}）` }
      void $.prompt.submit({ text: resumePrompt(file) }).catch(() => undefined)
      await update($, resume, () => null)
      return { text: '已要求接著上次的進度繼續。' }
    }
    if (verb === 'check') {
      const usage = await $.session.usage()
      const raised = await check($)
      const now = usage.rateLimits.map(r => `${LABELS[r.kind] ?? r.kind} ${r.percentUsed}%`).join('、') || '尚無額度資料'
      return { text: raised ? `${now}，已達門檻，請看輸入框上方。` : `${now}，還沒到門檻或已經問過。` }
    }
    if (verb === 'threshold') {
      const n = Number(value)
      if (!(n >= 1 && n <= 100)) return { text: '用法：/checkpoint threshold 1到100的數字（5 小時額度用到幾 % 時詢問）' }
      const limits = await thresholds($)
      await $.store.set('thresholds', { ...limits, five_hour: n })
      asked.clear()
      return { text: `5 小時額度用到 ${n}% 時會問你要不要暫存。` }
    }
    if (verb === 'status') {
      const limits = await thresholds($)
      const file = checkpointPath(await $.session.cwd())
      const has = await $.fs.exists(file)
      return { text: `門檻：5小時 ${limits.five_hour}%、本週 ${limits.seven_day}%\n暫存檔：${has ? file : '（目前沒有）'}` }
    }
    return { text: '用法：/checkpoint [save] | resume | check | threshold 數字 | status' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const question = await read($, ask)
    const saved = await read($, resume)
    if (question === null && saved === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        {question !== null && (
          <Box flexDirection="column">
            <Text color="yellow">
              ⚠ {LABELS[question.kind] ?? question.kind}額度已用 {question.percent}%
              {question.resetsAt ? `，${countdown(question.resetsAt, now)}` : ''}。專案可能跑不完，要暫存進度、下次接著跑嗎？
            </Text>
            <Box>
              <Button
                key="save-now"
                variant="primary"
                label="立刻暫存"
                onPress={async () => {
                  await save($, true)
                }}
              />
              <Text> </Text>
              <Button
                key="save-later"
                label="這輪結束後暫存"
                onPress={async () => {
                  await save($, false)
                }}
              />
              <Text> </Text>
              <Button key="save-no" label="不用" onPress={() => update($, ask, () => null)} />
            </Box>
          </Box>
        )}
        {saved !== null && (
          <Box flexDirection="column">
            <Text color="cyan">找到上次暫存的進度（{ago(saved.savedAt, now)}）。要接著跑嗎？</Text>
            <Box>
              <Button
                key="resume-yes"
                variant="primary"
                label="繼續"
                onPress={async () => {
                  void $.prompt.submit({ text: resumePrompt(saved.file) }).catch(() => undefined)
                  await update($, resume, () => null)
                }}
              />
              <Text> </Text>
              <Button
                key="resume-no"
                label="不用了"
                onPress={async () => {
                  const cur = await $.store.get('dismissed')
                  const map = cur && typeof cur === 'object' ? (cur as Record<string, number>) : {}
                  await $.store.set('dismissed', { ...map, [saved.file]: saved.savedAt })
                  await update($, resume, () => null)
                }}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
