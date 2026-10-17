import { rm } from 'node:fs/promises'
import { ConfigSchema } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from '../../src/app.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// Another machine's orchestrator, from this window (REMOTE-TADE.md §5.4,
// §9.4) — the whole of it through the window: a tab beside this machine's own
// orchestrator, that machine's conversation on it, what is typed there sent to
// that machine as its owner and to nothing here, escape stopping its turn
// there, and when its link comes back, what it says happened while the person
// was away. The far end is a real away view (`far.ts`) whose orchestrator and
// journal are scripted by the window's own rules (`far-talk.ts`).

const HOUR = 3_600_000

describe('another machine’s orchestrator, from this window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let root: string
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    root = one.repo.root
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))
  /** The lower pane's row of tabs: the one that starts the strip and names the orchestrator. */
  const tabs = () => rows().findLast((row) => row.startsWith('━') && row.includes('orchestrator'))
  /**
   * Its link up, as the row of tabs draws it: `vps` wearing none of a link's
   * marks (`machineMark`). Its name alone is on the row from the first frame,
   * as `◌ vps` while it is still dialling.
   */
  const live = () => {
    const row = tabs() ?? ''
    return /(^|\s)vps(\s|$)/.test(row) && !/[◌○✕] vps/.test(row)
  }

  /** Press a tab on the lower pane's row of tabs. */
  function tab(label: string): void {
    const lines = rows()
    const at = lines.findLastIndex((row) => row.startsWith('━') && row.includes('orchestrator'))
    const col = lines[at]?.indexOf(` ${label} `) ?? -1
    if (col < 0) throw new Error(`no tab "${label}" on ${lines[at]}`)
    wired.click(col + 1, at)
  }

  /** A far end called `vps`, made ready by `before`, and the window linked to it. */
  async function linkedTo(
    before: (far: FarEnd) => void = () => {},
    over: Parameters<typeof wired.start>[0] = {},
  ): Promise<{ far: FarEnd; app: App; device: string }> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    before(far)
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const app = await wired.start({
      config: ConfigSchema.parse({ projects: { app: { root } }, remotes: { vps } }),
      remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
      ...over,
    })
    await until('vps beside the orchestrator, linked', live, 20_000)
    return { far, app, device: session.device }
  }

  it('draws its conversation on its own tab, and sends what is typed there to it and nothing here', async () => {
    const asked: string[] = []
    const { far, device } = await linkedTo((far) => far.talk.reply('the release on vps is green'), {
      thinker: {
        ask: async (text) => {
          asked.push(text)
          return 'answered here'
        },
      },
    })
    // Heard — its projects along the top, from the same frame as the tabs — and what was
    // already said there is not news: no mark of something unread.
    await until('its projection heard', () => (rows()[0] ?? '').includes('vps ⋯1'), 20_000)
    expect(tabs()).not.toContain('vps •')
    tab('vps')
    await until('its conversation', () => shown('the release on vps is green'), 20_000)
    expect(shown('what you type here goes to the orchestrator on vps')).toBe(true)

    for (const char of 'start the deps bump there') terminal.press(char)
    terminal.press('\r')
    await until('that machine to be told', () => far.talk.said.length === 1, 20_000)
    // As this machine's owner, on that machine's own door: the owner channel.
    expect(far.talk.said[0]).toEqual({ said: 'start the deps bump there', device, here: true })
    // What it says back is that machine's, drawn here as the person's own words.
    await until('its turn, on its tab', () => shown('answering you · esc stops it'), 20_000)
    expect(shown('start the deps bump there')).toBe(true)
    // Nothing of it reached this machine's orchestrator, or became a line of theirs here.
    expect(asked).toEqual([])
    expect(await client.events({ types: ['said'] })).toEqual([])

    // Escape on its tab stops the turn there, and only there.
    terminal.press('\x1b')
    await until('its turn stopped there', () => !far.talk.busy, 20_000)
    expect(far.talk.lines.at(-1)).toMatchObject({ kind: 'tade', text: 'stopped' })

    // Its answer arrives on its tab, which is marked while somebody looks elsewhere.
    tab('orchestrator')
    far.talk.reply('done: the deps bump is queued on vps')
    await until('its tab marked unread', () => tabs()?.includes('vps •') === true, 20_000)
    tab('vps •')
    await until('its answer', () => shown('the deps bump is queued on vps'), 20_000)
  })

  it('says, once its link comes back, what happened there since the person was last there', async () => {
    const now = Date.now()
    const { far } = await linkedTo((far) => {
      far.talk.wrote('person_present', null, { device: 'mac' }, now - 3 * HOUR)
      far.talk.wrote('task_done', 'tade/fix-login', { by: 'agent' }, now - 2 * HOUR)
      // Finished before the person was last there: not news.
      far.talk.wrote('task_done', 'tade/old-news', { by: 'agent' }, now - 4 * HOUR)
      far.talk.waiting = [{ task: 'tade/deploy', at: now, said: 'wants an answer about Bash' }]
    })
    await until(
      'it said in the strip',
      () => shown('vps, since you were here: 1 waiting on you, 1 finished'),
      20_000,
    )
    // Asked once, cut where this window's link came up, in that machine's clock.
    expect(far.talk.cuts).toHaveLength(1)
    expect(far.talk.cuts[0]).toBeGreaterThanOrEqual(now - 1_000)
    expect(tabs()).toContain('vps •')
    tab('vps •')
    // The newest of it in view, as a conversation is read: the heading above is scrolled to.
    await until('the card on its tab', () =>
      shown('waiting on you: tade/deploy wants an answer about Bash'),
    )
    expect(shown('finished: tade/fix-login — its agent said so')).toBe(true)
    expect(shown('tade/old-news')).toBe(false)
  })

  it('passes the orchestrator’s sentence on only where a line of the person’s names that machine', async () => {
    const { far, app } = await linkedTo()
    // What a message there needs, in one frame: the link up and what that
    // machine holds heard — its project folded into its name along the top,
    // out of the same projection that carries its conversation.
    await until(
      'its conversation heard',
      () => live() && (rows()[0] ?? '').includes('vps ⋯1'),
      20_000,
    )
    const tools = app.remoteTools()
    await expect(
      tools.tell({ machine: 'vps', said: 'start the release', asked: 'start the release' }),
    ).rejects.toThrow(/Nothing they have said names vps/)
    await expect(tools.tell({ machine: 'lab', said: 'x', asked: 'x' })).rejects.toThrow(
      /No machine here is called lab: the ones linked are vps/,
    )
    expect(far.talk.said).toEqual([])

    await client.log.append({ type: 'said', detail: { text: 'ask the vps to start the release' } })
    const answer = await tools.tell({
      machine: 'vps',
      said: 'start the release',
      asked: 'ask the vps to start the release',
    })
    expect(answer).toContain('Passed on to the orchestrator on vps')
    expect(far.talk.said).toHaveLength(1)
    // Said there as this machine's orchestrator's words, never as the person's.
    expect(far.talk.said[0]?.said).toMatch(
      /^The orchestrator on .+ passes this on:\n\nstart the release$/,
    )
  })
})
