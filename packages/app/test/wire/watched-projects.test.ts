import type { TadeEvent } from '@tade/core'
import { ExtensionHost, type TadeExtension } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The projects a watch can see, which are the projects there are — now, not
// when the extensions loaded.
//
// A watch names its project and looks it up at every look, so which projects
// exist has to be asked of the config each time. It was read once, when the
// extensions loaded, and the answer never changed while the window stayed up:
// three watches turned on in a project that had been open for an hour spent
// the afternoon saying `✗ could not look: there is no project called
// zahlenzauber (there is tade, tade-web)`, once every ten minutes.
//
// Its other half is the opposite case. A watch outlives the project it names —
// closing one leaves its schedules exactly where they are — so a look at a
// closed project is a look at nothing. That is not a failed look either: it is
// a watch with nothing to watch, said once, in Tade's own voice.

/** What the watch did, for a test to read. */
interface Sky {
  /** The project each look was made about, in order. */
  looked: string[]
  found: { key: string; title: string }[]
  /** A quiet fact a look comes back with: nothing to look at, and not a failure. */
  said: string | null
}

function weather(sky: Sky): TadeExtension {
  return {
    name: 'weather',
    title: 'Weather',
    description: 'Whether it is raining.',
    watches: [
      {
        id: 'rain',
        title: 'Rain',
        means: 'Looks for rain over a project.',
        every: '10m',
        offers: 'ask',
        check: async (ctx) => {
          sky.looked.push(ctx.watching.name)
          return { found: [...sky.found], ...(sky.said ? { said: sky.said } : {}) }
        },
      },
    ],
  }
}

const TICK = 10 * 60_000 + 1_000

describe('the window, and the projects its watches look at', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  /** A window with the weather extension loaded and one project, `app`, open. */
  async function watching(sky: Sky) {
    terminal.columns = 140
    terminal.rows = 50
    const clock = { at: Date.now() }
    const extensions = await ExtensionHost.load({
      builtin: [weather(sky)],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({
      extensions,
      now: () => clock.at,
      thinker: { ask: async () => 'ok', tell: async () => {} },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    return { clock, window }
  }

  /** How many times a sentence starts a line on screen. */
  const times = (said: string) =>
    screenOf(terminal.written).filter((row) => row.includes(said)).length

  /** Every look written down, and what it said about itself. */
  const looks = async (): Promise<TadeEvent[]> => client.events({ types: ['watch_checked'] })

  /** A line the person themselves said, which is what closing a project needs. */
  const theySaid = (text: string) =>
    client.log.append({ type: 'said', task: null, detail: { text } })

  it('looks at a project opened after the watch was turned on, on its next look', async () => {
    const sky: Sky = { looked: [], found: [], said: null }
    const { clock, window } = await watching(sky)
    const opened = mkrepo()
    opened.commit('first')

    // Opened while the window is up, which is the whole of it: the extensions
    // loaded knowing about `app` and nothing else.
    expect(
      await window
        .configTools()
        .openProject({ path: opened.root, name: 'zahlenzauber', create: false }),
    ).toContain('Opened zahlenzauber')
    await window.queueTools().schedule({
      name: 'Rain',
      project: 'zahlenzauber',
      said: 'watch the rain there',
      watch: 'weather.rain',
      by: 'you',
    })

    clock.at += TICK
    await until('it looked at the new project', () => sky.looked.includes('zahlenzauber'))
    // And nothing went wrong: no red line, and no look written down as one.
    expect(times('could not look')).toBe(0)
    expect((await looks()).filter((event) => event.detail.problem)).toEqual([])
  }, 60_000)

  it('is quiet about a project that is closed, and says so once rather than every look', async () => {
    const sky: Sky = { looked: [], found: [], said: null }
    const { clock, window } = await watching(sky)
    const opened = mkrepo()
    opened.commit('first')
    await window
      .configTools()
      .openProject({ path: opened.root, name: 'zahlenzauber', create: false })
    await window.queueTools().schedule({
      name: 'Rain',
      project: 'zahlenzauber',
      said: 'watch the rain there',
      watch: 'weather.rain',
      by: 'you',
    })
    clock.at += TICK
    await until('it looked once', () => sky.looked.length === 1)

    // Closed. Its watch stays where it is — closing a project is not
    // forgetting its work — so from here every look is a look at nothing.
    await theySaid('close zahlenzauber, we are done with it')
    expect(
      await window.configTools().closeProject({
        project: 'zahlenzauber',
        said: 'close zahlenzauber, we are done with it',
      }),
    ).toContain('Closed zahlenzauber')
    expect(client.schedules().map((one) => one.id)).toEqual(['rain'])

    const quiet = 'Rain: zahlenzauber is not open, so there is nothing to watch'
    clock.at += TICK
    await until('said where a person would read it', () => times(quiet) === 1)
    // Never as trouble: nobody has anything to do about a project somebody
    // closed on purpose, so there is no `could not look` and no `!` beside it.
    expect(times('could not look')).toBe(0)
    expect((await looks()).filter((event) => event.detail.problem)).toEqual([])
    expect(screenOf(terminal.written).some((row) => /! Rain/.test(row))).toBe(false)

    // An hour of it, and it is still said once. It also never asks the
    // extension anything: there is nothing to ask about.
    for (let n = 0; n < 4; n++) {
      const written = (await looks()).length
      clock.at += TICK
      await until('another look went by', async () => (await looks()).length > written)
    }
    expect(times(quiet)).toBe(1)
    expect(sky.looked).toEqual(['zahlenzauber'])

    // Opened again, and it picks up where it was: the same schedule, looking.
    await window
      .configTools()
      .openProject({ path: opened.root, name: 'zahlenzauber', create: false })
    clock.at += TICK
    await until('looking again', () => sky.looked.length === 2)
    expect(times('could not look')).toBe(0)
  }, 60_000)

  it('says a project with nothing to check has nothing to check, and draws no red line', async () => {
    const sky: Sky = {
      looked: [],
      found: [],
      said: 'app has no remote: there is nothing to push to',
    }
    const { clock, window } = await watching(sky)
    await window.queueTools().schedule({
      name: 'Rain',
      project: 'app',
      said: 'watch the rain here',
      watch: 'weather.rain',
      by: 'you',
    })
    clock.at += TICK
    await until('it said so, in Tade’s own voice', () => times('Rain: app has no remote') === 1)
    // A project with no forge and no CI is a fact about that project, not a
    // failure to look at one: written down as a look that said something,
    // never as a look that could not happen.
    const written = await looks()
    expect(written.map((event) => event.detail.said)).toContain(
      'app has no remote: there is nothing to push to',
    )
    expect(written.filter((event) => event.detail.problem)).toEqual([])
    expect(times('could not look')).toBe(0)
    expect(screenOf(terminal.written).some((row) => /! Rain/.test(row))).toBe(false)

    // And it stays said once for as long as it stays true.
    for (let n = 0; n < 3; n++) {
      const count = (await looks()).length
      clock.at += TICK
      await until('another look went by', async () => (await looks()).length > count)
    }
    expect(times('Rain: app has no remote')).toBe(1)
  }, 60_000)
})
