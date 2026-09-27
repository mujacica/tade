import { ExtensionHost, type TadeExtension, Unreachable } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// A machine that cannot reach a network, and the watches that were finding
// that out one request at a time.
//
// The window under test is given its own answer to "can this machine reach
// anything" — never the machine it runs on, which a suite may not touch, and
// which would make every assertion here a fact about somebody's wifi.

/** Everything that happened that a test asserts on. Reset per test by the harness. */
interface Sky {
  /** Which watches actually looked, in order. */
  looked: string[]
  /** What the rain watch finds when it does look. */
  found: { key: string; title: string }[]
  /** A host the rain watch cannot reach, or null when it can. */
  unreachable: string | null
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
        means: 'Asks the radar, which is somewhere else.',
        every: '10m',
        // The whole of what makes it hold when there is no network.
        network: true,
        offers: 'ask',
        check: async () => {
          sky.looked.push('rain')
          if (sky.unreachable) throw new Unreachable(sky.unreachable, 'the radar did not answer')
          return { found: [...sky.found] }
        },
      },
      {
        id: 'attic',
        title: 'Attic',
        means: 'Listens to this house, and nothing else.',
        every: '10m',
        offers: 'ask',
        check: async () => {
          sky.looked.push('attic')
          return { found: [] }
        },
      },
    ],
  }
}

const TICK = 10 * 60_000 + 1_000

describe('the window, and a machine that cannot reach a network', () => {
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

  /** A window with both watches on, its own clock, and its own answer about the network. */
  async function watching(sky: Sky, machine: { routes: boolean; reaches: boolean }) {
    terminal.columns = 140
    terminal.rows = 50
    const told: string[] = []
    const clock = { at: Date.now() }
    const extensions = await ExtensionHost.load({
      builtin: [weather(sky)],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({
      extensions,
      now: () => clock.at,
      network: { route: () => machine.routes, reaches: async () => machine.reaches },
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    for (const [name, watch] of [
      ['Rain', 'weather.rain'],
      ['Attic', 'weather.attic'],
    ] as const) {
      await tools.schedule({ name, project: 'app', said: `watch the ${name}`, watch, by: 'you' })
    }
    return { clock, told }
  }

  /** How many times a sentence starts a line on screen. Wrapping keeps the first words together. */
  const times = (said: string) =>
    screenOf(terminal.written).filter((row) => row.includes(said)).length

  it('holds a watch that needs a network, says so once, and catches up when it is back', async () => {
    const sky: Sky = { looked: [], found: [], unreachable: null }
    const machine = { routes: true, reaches: true }
    const { clock, told } = await watching(sky, machine)

    clock.at += TICK
    await until('both looked', () => sky.looked.includes('rain') && sky.looked.includes('attic'))
    const before = sky.looked.filter((one) => one === 'rain').length

    // The wifi goes off. Nothing is asked of the radar at all: not a failed
    // look, not a `watch_checked` with a problem, and not a red line.
    machine.routes = false
    const attics = () => sky.looked.filter((one) => one === 'attic').length
    const looked = attics()
    clock.at += TICK
    await until('the tick went by', () => attics() > looked)
    await until('said where a person would read it', () => times('offline —') === 1)
    expect(sky.looked.filter((one) => one === 'rain')).toHaveLength(before)
    expect(
      (await client.events({ types: ['watch_checked'] })).filter((event) => event.detail.problem),
    ).toEqual([])

    // Hours of it, and it is said once. A watch that reads this machine and
    // nothing else keeps looking throughout: an outage is not a reason to stop
    // watching the attic.
    for (let n = 0; n < 4; n++) {
      const was = attics()
      clock.at += TICK
      await until('another tick went by', () => attics() > was)
    }
    expect(sky.looked.filter((one) => one === 'rain')).toHaveLength(before)
    expect(times('offline —')).toBe(1)

    // While it was not looking, the world went on. Nothing is lost: where its
    // last look left off was never moved, so the first look back finds all of it.
    sky.found.push(
      { key: 'shed', title: 'rain over the shed' },
      { key: 'yard', title: 'rain over the yard' },
    )
    machine.routes = true
    clock.at += TICK
    await until('back, and said once', () => times('back online') === 1)
    await until('it looked, and found what piled up', () =>
      told.some((text) => text.includes('shed') && text.includes('yard')),
    )
    expect(times('offline —')).toBe(1)
  }, 60_000)

  it('never mistakes one endpoint being down for the machine being offline', async () => {
    const sky: Sky = { looked: [], found: [], unreachable: null }
    const machine = { routes: true, reaches: true }
    const { clock } = await watching(sky, machine)

    // The radar is down and the machine is fine. That is the radar's news, and
    // it keeps the behaviour it has always had: written down, and said once.
    sky.unreachable = 'radar.example'
    clock.at += TICK
    await until('it said so', () => times('Rain could not look') === 1)
    await until(
      'and wrote it down',
      async () =>
        (await client.events({ types: ['watch_checked'] })).filter((event) => event.detail.problem)
          .length === 1,
    )
    expect(times('offline —')).toBe(0)

    // Still looking, every time it is due, because nothing here is paused.
    const tried = sky.looked.filter((one) => one === 'rain').length
    clock.at += TICK
    await until('it tried again', () => sky.looked.filter((one) => one === 'rain').length > tried)
    expect(times('offline —')).toBe(0)

    // The same host, on a machine that turns out not to be able to reach
    // anything, is the other answer — and now the watches are held.
    machine.reaches = false
    const held = sky.looked.filter((one) => one === 'rain').length
    clock.at += TICK
    await until('held, and said', () => times('offline —') === 1)
    clock.at += TICK
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(sky.looked.filter((one) => one === 'rain')).toHaveLength(held + 1)
  }, 60_000)
})
