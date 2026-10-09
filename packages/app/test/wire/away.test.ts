import { appendFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, startOfToday } from '@tade/core'
import { readDevices, writeDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import type { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Away } from '../../src/wire/web.ts'

// The window's end of the away view: its lifetime, what it costs when nobody
// is looking, and the keypress that is the whole of pairing's authorisation.
//
// **Loopback throughout, on a port the machine said was free.** A test that
// bound the LAN would be a listener on whoever's network ran it, and that is
// the one thing this slice must never leave behind. What a `lan` bind would
// bind is a table in `@tade/web` (`listenOn`), asked there without a socket.

const open: Away[] = []

afterEach(async () => {
  for (const one of open) await one.stop()
  open.length = 0
})

/** Everything `Away` reads of `Live`, counting every read. */
function heldState(over: { tasks?: number } = {}) {
  const reads: string[] = []
  const world = {
    generatedAt: new Date(1_000).toISOString(),
    projects: [
      {
        name: 'shop',
        root: '/Users/testperson/work/shop',
        brief: null,
        untracked: [],
        tasks: Array.from({ length: over.tasks ?? 1 }, (_, at) => ({
          id: `shop/task-${at}`,
          project: 'shop',
          intent_spoken: 'make the refunds work',
          branch: 'tade/refunds',
          worktree: '/Users/testperson/work/.worktrees/refunds',
          created: new Date(500).toISOString(),
          state: 'working' as const,
          reason: '4 files touched',
          stalled: false,
          git: null,
          agents: [],
          lanes: [],
        })),
      },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  }
  const live = {
    get world() {
      reads.push('world')
      return world
    },
    get events() {
      reads.push('events')
      return []
    },
    get pending() {
      reads.push('pending')
      return []
    },
    get queued() {
      reads.push('queued')
      return []
    },
    get tasks() {
      reads.push('tasks')
      return []
    },
    seenActions: () => {
      reads.push('seenActions')
      return null
    },
    spendToday: () => {
      reads.push('spendToday')
      return { byTask: {} }
    },
    queueFacts: () => {
      reads.push('queueFacts')
      return { tasks: new Map(), finished: new Map(), events: [], now: 1_000 }
    },
    notes: () => {
      reads.push('notes')
      return []
    },
  }
  return { live: live as unknown as Live, reads }
}

async function wiring(
  over: { web?: Record<string, unknown>; live?: Live; now?: number; log?: string } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'tade-away-'))
  let state: AppState = initialState()
  let draws = 0
  const news: string[] = []
  const decided: boolean[] = []
  const logged: { type: string; detail: Record<string, unknown> }[] = []
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({
        surfaces: { web: { port: await freePort(), ...(over.web ?? {}) } },
      }),
      client: {
        log: {
          append: async (line: { type: string; detail: Record<string, unknown> }) => {
            if (over.log !== undefined) throw new Error(over.log)
            logged.push(line)
          },
        },
        planUsage: () => [],
      },
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: over.live ?? null,
    now: () => over.now ?? 1_000,
    openedAt: 0,
    draw: () => {
      draws += 1
    },
    note: () => {},
  } as unknown as Wiring
  const away = new Away(wire, {
    decided: (allow) => {
      decided.push(allow)
    },
    news: (said) => news.push(said),
  })
  open.push(away)
  return { away, home, news, decided, logged, at: () => state, drawn: () => draws }
}

describe('its lifetime', () => {
  it('constructs nothing at all while it is off', async () => {
    const { away, logged } = await wiring()
    await away.open()
    // Off is the default, so this is what every window that never turns it on
    // does: no listener, nothing bound, and nothing in the journal — because
    // nothing happened.
    expect(logged).toEqual([])
    expect(away.panel()).toEqual({})
  })

  it('listens on this machine alone when a person turns it on', async () => {
    const { away, logged } = await wiring({ web: { enabled: true } })
    await away.open()
    const line = logged.find((one) => one.type === 'web_enabled')
    expect(line?.detail.enabled).toBe(true)
    expect(line?.detail.bind).toBe('loopback')
    // Both spellings of this machine, and nothing else: `0.0.0.0` and `::`
    // would be the network, which is a second act nobody took.
    const bound = String(line?.detail.bound ?? '')
    expect(bound).toContain('127.0.0.1:')
    for (const address of ['0.0.0.0', '192.168']) expect(bound).not.toContain(address)
  })

  it('says so in the journal when it goes, and is safe to stop twice', async () => {
    const { away, logged } = await wiring({ web: { enabled: true } })
    await away.open()
    await away.stop()
    expect(logged.filter((one) => one.type === 'web_enabled')).toHaveLength(2)
    expect(logged.at(-1)?.detail.enabled).toBe(false)
    await expect(away.stop()).resolves.toBeUndefined()
  })

  it('says so in the strip when a line would not go in the journal', async () => {
    // Not swallowed: `web_paired` is the audit, and "every act one takes is in
    // the journal under its id" is half of what stands against a device
    // somebody else let in. A line that silently did not land would make that
    // sentence quietly untrue.
    const { away, news } = await wiring({ web: { enabled: true }, log: 'the disk is full' })
    await away.open()
    expect(news.join(' ')).toContain('could not write web_enabled down')
    expect(news.join(' ')).toContain('the disk is full')
  })

  it('is safe to stop before it was ever opened', async () => {
    const { away, logged } = await wiring({ web: { enabled: true } })
    await expect(away.stop()).resolves.toBeUndefined()
    expect(logged).toEqual([])
  })
})

describe('what it costs when nobody is looking', () => {
  it('reads nothing of the window over a hundred beats', async () => {
    const held = heldState({ tasks: 40 })
    const { away } = await wiring({ web: { enabled: true }, live: held.live })
    await away.open()
    held.reads.length = 0
    for (let at = 0; at < 100; at++) away.beat()
    // Not "cheap": **nothing**. Building a projection means four folds over
    // the whole journal plus a row per task, and an enabled away view nobody
    // has paired a phone to must not pay for one of them every two seconds.
    expect(held.reads).toEqual([])
  })

  it('builds the projection when something actually asks', async () => {
    const held = heldState()
    const { away } = await wiring({ web: { enabled: true }, live: held.live })
    await away.open()
    await paired(away)
    held.reads.length = 0
    // A request is not idle: this is the one place the work belongs.
    const reading = readingOf(away)
    expect(reading.snapshot().tasks).toHaveLength(1)
    expect(held.reads).toContain('world')
  })

  it('builds it once for four tabs of one phone', async () => {
    const held = heldState()
    const { away } = await wiring({ web: { enabled: true }, live: held.live })
    await away.open()
    await paired(away)
    const reading = readingOf(away)
    reading.snapshot()
    held.reads.length = 0
    for (let at = 0; at < 4; at++) reading.snapshot()
    // Memoised until the next beat, so a page refresh storm is one build.
    expect(held.reads).toEqual([])
  })

  it('answers before the first look, and never as “nothing is running”', async () => {
    // `Live` with no `world` yet: `unknown`, which reaches the page as a
    // projection with no rows and its own freshness — never an empty
    // workspace, which everything above reads as *nothing is running*.
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    await paired(away)
    const snapshot = readingOf(away).snapshot()
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.fresh.epoch).not.toBe('')
    // Nothing has been folded, so there is no period any money figure covers:
    // `unknown`, and never a date in 1970 that a page would draw as a time.
    expect(snapshot.fresh.spendSince).toBeNull()
  })

  it('says the period its money figures cover, as the fold it actually made', async () => {
    // **The label and the number have to be of the same day.** The window
    // hands over `spendToday`'s fold, which starts at its own midnight — so a
    // task that cost forty dollars yesterday and nothing since arrives with
    // no cost at all, and a page with no period on it draws that as *not
    // recorded*. Asserted against `startOfToday` of the window's own clock,
    // because a second rule for the same moment is how the two come to
    // disagree.
    const now = Date.parse('2026-10-08T14:30:00.000Z')
    const { live } = heldState()
    const { away } = await wiring({ web: { enabled: true }, live, now })
    await away.open()
    await paired(away)
    const snapshot = readingOf(away).snapshot()
    expect(snapshot.fresh.spendSince).toBe(new Date(startOfToday(now)).toISOString())
  })
})

describe('letting a device in', () => {
  it('hands the keys to the agents while nothing is asking', async () => {
    const { away, decided } = await wiring({ web: { enabled: true } })
    await away.open()
    await away.decide(true)
    expect(decided).toEqual([true])
  })

  it('grants names and counts on a yes, and nothing wider', async () => {
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    const asked = asking(away)
    await away.decide(true)
    const said = await asked
    expect(said).toEqual({ let: true, projects: null, granted: [] })
  })

  it('refuses on a no, and says which it was', async () => {
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    const asked = asking(away)
    await away.decide(false)
    expect(await asked).toEqual({ let: false, why: 'refused' })
  })

  it('opens the panel with the question on it, and says so in the strip', async () => {
    const { away, at, news } = await wiring({ web: { enabled: true } })
    await away.open()
    asking(away)
    expect(at().panel?.kind).toBe('away')
    expect(news.join(' ')).toContain('wants to pair')
    const drawn = away.panel()?.away
    expect(drawn?.asking?.label).toBe('iPhone')
    expect(drawn?.asking?.from).toBe('192.168.1.42')
  })
})

describe('disconnecting', () => {
  it('disconnects everything with no network, and says how many', async () => {
    const { away, home, news } = await wiring({ web: { enabled: true } })
    await away.open()
    await twoPaired(home)
    await away.reread()
    await carry(away, 'away-revoke-all')
    expect(news.join(' ')).toContain('2 device(s) disconnected')
    const read = await readDevices(home)
    expect(read.devices.filter((one) => one.revoked === null)).toEqual([])
  })

  it('disconnects one, by its id, and leaves the others', async () => {
    const { away, home } = await wiring({ web: { enabled: true } })
    await away.open()
    await twoPaired(home)
    await away.reread()
    await carry(away, 'away-revoke:00112233445566aa')
    const read = await readDevices(home)
    const live = read.devices.filter((one) => one.revoked === null).map((one) => one.id)
    expect(live).toEqual(['00112233445566bb'])
  })

  it('says why a control could not be carried out, rather than doing nothing', async () => {
    const { away, home } = await wiring({ web: { enabled: true } })
    await away.open()
    await twoPaired(home)
    await away.reread()
    // An id that is not one: the device list refuses the line rather than
    // writing a revocation for something that does not exist.
    await carry(away, 'away-revoke:not-an-id')
    expect(away.panel()?.away?.problem).not.toBeNull()
  })
})

describe('how it is opened at all', () => {
  it('answers the command a person types, and nothing else', () => {
    const names = Object.keys(new Away({} as never, {} as never).actions())
    expect(names).toEqual(['/away'])
  })
})

describe('what the panel is told', () => {
  it('says what is listening and the clause about this machine’s agents', async () => {
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    const view = await viewOf(away)
    expect(view.listening).toBe(true)
    expect(view.bind).toBe('loopback')
    expect(view.agents.toLowerCase()).toContain('agent on this machine could pair itself')
  })

  it('carries the LAN sentence whole, whichever bind it is on', async () => {
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    const view = await viewOf(away)
    // Carried always and drawn only on a `lan` bind, so the panel cannot show
    // half of it: the words are the domain's, said once (`LAN_IS_PLAINTEXT`).
    expect(view.lan).toContain('same wifi')
    expect(view.lan).toContain('tailscale serve')
  })

  it('mints a code whose URL is for this machine, with the ticket in its fragment', async () => {
    const { away } = await wiring({ web: { enabled: true } })
    await away.open()
    const view = await viewOf(away)
    expect(view.ticket?.url).toMatch(/^http:\/\/localhost:\d+\/pair#t=/)
    expect(view.code.length).toBeGreaterThan(8)
    expect(view.ticket?.secondsLeft).toBeGreaterThan(0)
  })

  it('shows every device there is even with nothing listening', async () => {
    // The list *is* the mitigation: a window with the away view off still has
    // to be able to show what was paired and disconnect it, and saying "no
    // device is paired" over a file holding two is the one lie this panel
    // exists to prevent.
    const { away, home } = await wiring()
    await twoPaired(home)
    const view = await viewOf(away)
    expect(view.listening).toBe(false)
    expect(view.devices).toHaveLength(2)
  })

  it('says a damaged device list was skipped rather than showing a short one', async () => {
    const { away, home } = await wiring()
    await twoPaired(home)
    await appendFile(join(home, 'web-devices.jsonl'), '{"kind":"pai\n')
    const view = await viewOf(away)
    expect(view.devices).toHaveLength(2)
    expect(view.problem).toContain('could not be read')
  })

  it('shows every device there is, with what each may read', async () => {
    const { away, home } = await wiring({ web: { enabled: true } })
    await away.open()
    await twoPaired(home)
    await away.reread()
    const view = await viewOf(away)
    expect(view.devices.map((one) => one.label)).toEqual(['iPhone', 'MacBook'])
    expect(view.devices[0]?.reads).toEqual(['notes'])
    expect(view.devices[1]?.reads).toEqual([])
  })
})

/**
 * A port nothing is on, found by letting the machine pick one and giving it
 * back.
 *
 * `surfaces.web.port` is at least 1 by schema — a person's bookmark has to
 * keep working across restarts, so "whatever is free" is not a setting — and a
 * fixed number in a test is a test that fails on whoever's laptop already has
 * something there.
 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** Open the panel, then read what it would be told. */
async function viewOf(away: Away) {
  await run(away, OPEN)
  const view = away.panel()?.away
  if (view === null || view === undefined) throw new Error('the panel was told nothing')
  return view
}

function run(away: Away, action: string): Promise<void> | void {
  return away.actions()[action]?.('')
}

function carry(away: Away, control: string): Promise<void> | void {
  const panel = {
    kind: 'away' as const,
    scroll: 0,
    chosen: 0,
    moved: false,
    busy: false as const,
  }
  return away.submits().away?.(panel, control)
}

/** The command a person types, which is the one way the panel is opened. */
const OPEN = '/away'

/** A pairing question, asked as the server would ask it. */
function asking(away: Away) {
  const confirm = (away as unknown as { confirm: (ask: unknown) => Promise<unknown> }).confirm
  return confirm.call(away, { label: 'iPhone', from: '192.168.1.42', host: '127.0.0.1:7654' })
}

/** One paired device in the file, and the away view told about it. */
async function paired(away: Away): Promise<void> {
  const home = (away as unknown as { wire: { opts: { home: string } } }).wire.opts.home
  await writeDevices(home, [device('00112233445566aa', 'iPhone', ['notes'])])
  await away.reread()
}

async function twoPaired(home: string): Promise<void> {
  await writeDevices(home, [
    device('00112233445566aa', 'iPhone', ['notes']),
    device('00112233445566bb', 'MacBook', []),
  ])
}

function device(id: string, label: string, granted: string[]) {
  return {
    kind: 'paired' as const,
    device: id,
    at: new Date(500).toISOString(),
    label,
    digest: 'a'.repeat(64),
    host: '127.0.0.1:7654',
    csrf: 'x'.repeat(43),
    until: new Date(1_000 + 86_400_000).toISOString(),
    scopes: ['read' as const],
    projects: null,
    granted: granted as ('notes' | 'titles')[],
    from: '192.168.1.42',
  }
}

/** The reading the server would be handed for the one paired device. */
function readingOf(away: Away) {
  const made = (
    away as unknown as {
      readingFor: (reach: unknown) => {
        snapshot: () => { tasks: unknown[]; fresh: { epoch: string; spendSince: string | null } }
      }
    }
  ).readingFor
  return made.call(away, {
    device: '00112233445566aa',
    projects: { kind: 'every' },
    granted: [],
  })
}
