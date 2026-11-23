import { type Arm, ConfigSchema } from '@tade/core'
import { rememberUpdates, type UpdateLook } from '@tade/workbench/programs'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { RUN_NEEDS_A_SCREEN, stopsAndComeBack, Updates } from '../../src/wire/updates.ts'
import { NO_WINDOW } from '../../src/wire/web-restart.ts'
import { lookWith, program } from '../updates-fixture.ts'

// Keeping what Tade runs current, from the window: the chip's facts, the check
// on a clock, and the one way an update is run.
//
// Built by hand rather than through the harness, like `machine.test.ts`: what
// a run does is open a terminal through the deps, type into it through the
// client and read what it printed back, and the client here prints what a
// shell would — the ending the line asked for, or a failure — so every path is
// asserted without a shell. `updates-run.test.ts` is the same run against a
// real one.

interface Did {
  what: string
  with: unknown[]
}

/** How the fake terminal answers each line typed into it, by the command at its front. */
type Answer = 'ok' | 'failed' | 'closed' | 'nothing'

function world(
  over: {
    /** What each read hands back, in turn; the last is kept. */
    looks?: UpdateLook[]
    /** Handed a way to ask, as a real window is. */
    asking?: boolean
    answers?: Record<string, Answer>
    said?: string[]
    now?: number
    check?: 'daily' | 'weekly' | 'never'
    detach?: boolean
    /** Files of Tade's own code changed in its checkout since it started (`own-code.ts`). */
    ownCode?: readonly string[]
    /** How many lanes a reload would end. */
    stops?: number
    /** How far the turn in flight reaches: the keyboard's unless given. */
    arm?: Arm
    /** No screen (`tade serve`). */
    faceless?: boolean
    /** Nothing that would start Tade again: a `tade serve` started by hand. */
    noReload?: boolean
  } = {},
) {
  const did: Did[] = []
  let state: AppState = initialState()
  const looks = [...(over.looks ?? [lookWith()])]
  const home = tmp('tade-updates-')
  let watcher: { onData: (chunk: Uint8Array) => void; onExit?: () => void } | null = null
  const print = (text: string) => watcher?.onData(Buffer.from(text))
  const client = {
    driver: { capabilities: { detach: over.detach ?? false } },
    async watch(lane: string, onData: (chunk: Uint8Array) => void, opts: { onExit?: () => void }) {
      did.push({ what: 'watch', with: [lane] })
      watcher = { onData, ...(opts.onExit ? { onExit: opts.onExit } : {}) }
      return { snapshot: '', cols: 80, rows: 24, stop: () => did.push({ what: 'stop', with: [] }) }
    },
    async runInTerminal(id: string, line: string) {
      did.push({ what: 'runInTerminal', with: [id, line] })
      const nonce = /tade-update-([0-9a-f]+) ok/.exec(line)?.[1] ?? ''
      const command = line.split(' && printf')[0] ?? ''
      const answer = over.answers?.[command] ?? 'ok'
      // As a shell would: the line echoed first, then what it printed.
      queueMicrotask(() => {
        print(`$ ${line}\r\n`)
        if (answer === 'ok') print(`tade-update-${nonce}-ok\r\n`)
        if (answer === 'failed') print(`Error: it is locked\r\ntade-update-${nonce}-failed\r\n`)
        if (answer === 'closed') watcher?.onExit?.()
      })
    },
    async readTerminal() {
      // The screen as a shell left it: the line typed echoed, then what it printed.
      const line = String(did.findLast((d) => d.what === 'runInTerminal')?.with[1] ?? '')
      const nonce = /tade-update-([0-9a-f]+) ok/.exec(line)?.[1] ?? ''
      return `$ ${line}\nError: it is locked\ntade-update-${nonce}-failed\n$ `
    },
    async events() {
      return (over.said ?? []).map((text) => ({ type: 'said', detail: { text } }))
    },
  }
  const reads: boolean[] = []
  const wire = {
    opts: {
      config: ConfigSchema.parse({
        projects: { shop: { root: '/tmp/shop' } },
        surfaces: { window: { check_updates: over.check ?? 'daily' } },
      }),
      home,
      client,
      // The window's own reload, the one the restart bar's press ends in.
      ...(over.noReload
        ? {}
        : {
            reloadWindow: async () => {
              did.push({ what: 'reloadWindow', with: [] })
            },
          }),
      ...(over.asking
        ? {
            updates: async (_config: unknown, _home: string, ask: boolean) => {
              reads.push(ask)
              const next = looks.length > 1 ? looks.shift() : looks[0]
              return { ...(next ?? lookWith()), asked: ask }
            },
          }
        : {}),
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: null,
    now: () => over.now ?? 10 * 60_000,
    openedAt: 0,
    draw: () => {},
    note: (err: unknown) => {
      state = { ...state, notice: err instanceof Error ? err.message : String(err) } as AppState
    },
  } as unknown as Wiring
  const told: string[] = []
  const subject = new Updates(wire, {
    reload: () => did.push({ what: 'reload', with: [] }),
    reloadStops: () => over.stops ?? 0,
    ...(over.arm ? { arm: () => over.arm as Arm } : {}),
    ...(over.faceless ? { faceless: true as const } : {}),
    terminal: async (name) => {
      did.push({ what: 'terminal', with: [name] })
      return 'shop/terminals/1'
    },
    news: (said) => told.push(said),
    ...(over.ownCode
      ? { ownCode: () => ({ changed: over.ownCode ?? [], startedOn: 'df4df5b1bcdff6ec' }) }
      : {}),
  })
  return { subject, did, told, reads, home, at: () => state }
}

/** The run's lines typed, by their command. */
const typed = (did: Did[]) =>
  did
    .filter((one) => one.what === 'runInTerminal')
    .map((one) => String(one.with[1]).split(' && printf')[0])

describe('the strip’s chip', () => {
  it('says nothing while nothing could move forward', async () => {
    const one = world({ asking: true, looks: [lookWith({ programs: [program('gh')] })] })
    await one.subject.tools().read(true)
    expect(one.subject.facts()).toEqual({})
  })

  it('counts what the last window found, read back as this one opens', async () => {
    const one = world()
    await rememberUpdates(
      one.home,
      lookWith({ tadeNewer: true, programs: [program('gh', { behind: true })] }),
    )
    await one.subject.recall()
    expect(one.subject.facts()).toEqual({ updates: { behind: 2, running: null, reload: false } })
  })

  it('turns into the reload once Tade’s own code changed in its checkout', async () => {
    expect(world({ ownCode: [] }).subject.facts()).toEqual({})
    const one = world({
      ownCode: ['packages/app/src/wire/updates.ts', 'packages/web/src/routes.ts'],
    })
    expect(one.subject.facts()).toEqual({ updates: { behind: 0, running: null, reload: true } })
    const read = JSON.parse(await one.subject.tools().read(false))
    expect(read.reloadOwed).toBe(
      "Tade's own code changed in its checkout since it started on df4df5b1: packages/app/src/wire/updates.ts and 1 more file. This window runs the code it opened on until it reloads.",
    )
  })

  it('keeps nothing that never asked what is current', async () => {
    const one = world()
    await rememberUpdates(one.home, lookWith({ asked: false, tadeNewer: true }))
    await one.subject.recall()
    expect(one.subject.facts()).toEqual({})
  })
})

describe('running an update', () => {
  const behind = () =>
    lookWith({ programs: [program('gh', { title: 'GitHub CLI', behind: true }), program('tmux')] })

  it('types the exact command into the updates terminal and says what it updated', async () => {
    const one = world({ asking: true, looks: [behind(), lookWith({ programs: [program('gh')] })] })
    await one.subject.tools().read(true)
    await one.subject.run([
      { about: 'gh', title: 'GitHub CLI', command: 'brew upgrade gh', from: '1.0.0', to: '1.1.0' },
    ])
    // The terminal first, then what it printed watched, then the line typed.
    expect(one.did.map((d) => d.what).slice(0, 3)).toEqual(['terminal', 'watch', 'runInTerminal'])
    expect(one.did[0]?.with).toEqual(['updates'])
    expect(typed(one.did)).toEqual(['brew upgrade gh'])
    // Said in the conversation, told to the orchestrator, and asked again after.
    expect(one.at().notice).toBe('Updated GitHub CLI to 1.1.0.')
    expect(one.told).toEqual(['Updated GitHub CLI to 1.1.0.'])
    expect(one.reads).toEqual([true, true])
    expect(one.subject.facts()).toEqual({})
  })

  it('runs every step behind from the chip, one after another', async () => {
    const one = world({
      asking: true,
      looks: [
        lookWith({ programs: [program('gh', { behind: true }), program('jq', { behind: true })] }),
      ],
    })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    expect(typed(one.did)).toEqual(['brew upgrade gh', 'brew upgrade jq'])
  })

  it('says how far it is while it runs', async () => {
    const one = world({
      asking: true,
      looks: [
        lookWith({ programs: [program('gh', { behind: true }), program('jq', { behind: true })] }),
      ],
      answers: { 'brew upgrade gh': 'nothing' },
    })
    await one.subject.tools().read(true)
    void one.subject.actions()['updates-run']?.('')
    await waitFor(() => typed(one.did).length === 1)
    expect(one.subject.facts()).toEqual({
      updates: { behind: 2, running: { done: 0, of: 2 }, reload: false },
    })
  })

  it('says a failure in the conversation with what it printed, and stops nothing else', async () => {
    const one = world({
      asking: true,
      looks: [
        lookWith({ programs: [program('gh', { behind: true }), program('jq', { behind: true })] }),
      ],
      answers: { 'brew upgrade gh': 'failed' },
    })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    const said = String(one.at().notice)
    expect(said).toContain('gh (`brew upgrade gh`) failed: Error: it is locked.')
    expect(said).toContain('Updated jq to 1.1.0.')
    expect(said).toContain('the updates terminal')
  })

  it('stops at a terminal that was closed under it, and says so', async () => {
    const one = world({
      asking: true,
      looks: [
        lookWith({ programs: [program('gh', { behind: true }), program('jq', { behind: true })] }),
      ],
      answers: { 'brew upgrade gh': 'closed' },
    })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    expect(typed(one.did)).toEqual(['brew upgrade gh'])
    expect(one.told[0]).toContain('closed before it finished')
  })

  it('offers the reload where Tade itself moved, and turns the chip into it', async () => {
    const one = world({
      asking: true,
      looks: [lookWith({ tadeNewer: true }), lookWith({ commit: '1a2b3c4' })],
    })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    expect(one.told[0]).toContain('Tade itself moved')
    expect(one.at().panel).toEqual({
      kind: 'reload',
      field: 'cancel',
      busy: false,
      updated: { to: '1a2b3c4', survives: false },
    })
    expect(one.subject.facts()).toEqual({ updates: { behind: 0, running: null, reload: true } })
    await one.subject.actions()['updates-reload']?.('')
    expect(one.did.at(-1)?.what).toBe('reload')
  })

  it('owes no reload where a pull found nothing to pull', async () => {
    const one = world({ asking: true, looks: [lookWith({ tadeNewer: true }), lookWith()] })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    expect(one.at().panel).toBeNull()
    expect(one.subject.facts()).toEqual({})
  })

  it('never opens the offer over a panel somebody has open', async () => {
    const one = world({
      asking: true,
      looks: [lookWith({ tadeNewer: true }), lookWith({ commit: '1a2b3c4' })],
    })
    await one.subject.tools().read(true)
    const settings = { kind: 'keys' } as unknown as AppState['panel']
    ;(one.subject as unknown as { wire: Wiring }).wire.put({ ...one.at(), panel: settings })
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    expect(one.at().panel).toBe(settings)
    expect(one.subject.facts()).toMatchObject({ updates: { reload: true } })
  })
})

describe('the Updates page’s buttons', () => {
  it('reloads through the one path every reload goes', async () => {
    const one = world()
    ;(one.subject as unknown as { wire: Wiring }).wire.put({
      ...one.at(),
      panel: { kind: 'settings' },
    } as AppState)
    await one.subject.action('updates:reload')
    // Asking first when it would stop agents living inside this window is the
    // reload's own business; what this must not do is a second way of doing it.
    expect(one.did.map((d) => d.what)).toEqual(['reload'])
    expect(one.at().panel).toBeNull()
  })

  it('runs one program’s update the way the chip runs them all', async () => {
    const one = world({ asking: true, looks: [lookWith({ programs: [program('tmux')] })] })
    await one.subject.tools().read(true)
    await one.subject.action('updates:update:tmux')
    await waitFor(() => one.told.length > 0)
    expect(typed(one.did)).toEqual(['brew upgrade tmux'])
  })

  it('does nothing for a button that is not on the page', async () => {
    const one = world()
    await one.subject.action('updates:something-else')
    expect(one.did).toEqual([])
  })
})

describe('the check on a clock', () => {
  const stale = () => lookWith({ at: 0 })

  it('asks once the last answer is older than the setting, never in a window’s first minute', async () => {
    const day = 24 * 60 * 60_000
    const early = world({ asking: true, now: 30_000 })
    early.subject.beat()
    expect(early.reads).toEqual([])

    const due = world({ asking: true, looks: [stale()], now: day + 1 })
    due.subject.beat()
    await waitFor(() => due.reads.length > 0)
    expect(due.reads).toEqual([true])
  })

  it('asks nothing where the window was not handed a way to, or the setting says never', () => {
    const day = 24 * 60 * 60_000
    const test = world({ now: day + 1 })
    test.subject.beat()
    // Not asking at all: a test suite's window may never reach the network.
    expect((test.subject as unknown as { busy: boolean }).busy).toBe(false)
    const never = world({ asking: true, check: 'never', now: day + 1 })
    never.subject.beat()
    expect(never.reads).toEqual([])
  })

  it('waits for the setting’s interval after an answer, and an hour after a try', async () => {
    const day = 24 * 60 * 60_000
    const one = world({ asking: true, looks: [lookWith({ at: day })], now: day + 60 * 60_000 })
    await one.subject.tools().read(true)
    one.reads.length = 0
    one.subject.beat()
    expect(one.reads).toEqual([])
  })
})

describe('the orchestrator’s tools', () => {
  it('runs an update only when something they said asks for one', async () => {
    const quiet = world({ asking: true, said: ['how are the agents doing?'] })
    await expect(
      quiet.subject.tools().run({ which: [], said: 'update everything' }),
    ).rejects.toThrow('Nothing they have said asks for an update')
    await expect(quiet.subject.tools().run({ which: [], said: '' })).rejects.toThrow(
      'An update is only done when somebody asks for it',
    )
    expect(typed(quiet.did)).toEqual([])
  })

  it('runs what they named and says what it updated', async () => {
    const one = world({
      asking: true,
      said: ['please upgrade gh'],
      looks: [
        lookWith({ programs: [program('gh', { behind: true }), program('jq', { behind: true })] }),
      ],
    })
    const said = await one.subject.tools().run({ which: ['gh'], said: 'please upgrade gh' })
    expect(typed(one.did)).toEqual(['brew upgrade gh'])
    expect(said).toBe('Updated gh to 1.1.0.')
  })

  it('says there is nothing to do where nothing is behind', async () => {
    const one = world({ asking: true, said: ['install the updates'] })
    expect(await one.subject.tools().run({ which: [], said: 'install the updates' })).toContain(
      'nothing to update',
    )
  })

  it('reloads only when they ask, and answers before it goes', async () => {
    const no = world({ said: ['update tade'] })
    await expect(no.subject.tools().reload({ said: 'reload' })).rejects.toThrow(
      'Nothing they have said asks for a reload',
    )
    const yes = world({ said: ['ok, reload it'] })
    const said = await yes.subject.tools().reload({ said: 'ok, reload it' })
    expect(said).toContain('Reloading in a moment')
    // Answered first: the reload ends the turn the answer would have gone to.
    expect(yes.did.some((d) => d.what === 'reload')).toBe(false)
    await waitFor(() => yes.did.some((d) => d.what === 'reload'))
  })

  it('asks at the panel where lanes would stop and the keyboard asked', async () => {
    const here = world({ said: ['restart tade'], stops: 2 })
    expect(await here.subject.tools().reload({ said: 'restart tade' })).toContain(
      'the reload panel is theirs to press',
    )
    await waitFor(() => here.did.some((d) => d.what === 'reload'))
    expect(here.did.some((d) => d.what === 'reloadWindow')).toBe(false)
  })

  it('goes ahead on their words from their own phone, saying where the phone shows what stops and comes back', async () => {
    const phone = world({
      said: ['restart tade'],
      stops: 2,
      arm: { how: 'owner', device: 'a1b2c3d4e5f60718', theirs: true },
    })
    const said = await phone.subject.tools().reload({ said: 'restart tade' })
    expect(said).toBe(stopsAndComeBack(2))
    expect(said).toContain('2 lanes run inside this window, so they stop now')
    expect(said).toContain('comes back where it left off')
    // In the conversation, which is what the phone shows: no panel at a screen it cannot reach.
    expect(phone.at().transcript.entries.at(-1)).toMatchObject({ kind: 'tade', text: said })
    expect(phone.did.some((d) => d.what === 'reloadWindow')).toBe(false)
    await waitFor(() => phone.did.some((d) => d.what === 'reloadWindow'))
    expect(phone.did.some((d) => d.what === 'reload')).toBe(false)
  })

  it('never takes a narrower device’s turn, or a machine link’s, for the person’s press', async () => {
    for (const arm of [
      { how: 'remote', device: 'a1b2c3d4e5f60718', projects: null, may: ['answer', 'steer'] },
      { how: 'owner', device: 'machine vps' },
    ] as Arm[]) {
      const other = world({ said: ['restart tade'], stops: 1, arm })
      expect(await other.subject.tools().reload({ said: 'restart tade' })).toContain(
        'the reload panel is theirs to press',
      )
      await waitFor(() => other.did.some((d) => d.what === 'reload'))
      expect(other.did.some((d) => d.what === 'reloadWindow')).toBe(false)
    }
  })

  describe('with no screen', () => {
    const phone: Arm = { how: 'owner', device: 'a1b2c3d4e5f60718', theirs: true }

    it('starts Tade again where nothing would stop, answering before it goes', async () => {
      const serve = world({ said: ['restart tade'], faceless: true })
      expect(await serve.subject.tools().reload({ said: 'restart tade' })).toContain(
        'Reloading in a moment',
      )
      expect(serve.did.some((d) => d.what === 'reload')).toBe(false)
      await waitFor(() => serve.did.some((d) => d.what === 'reload'))
    })

    it('goes ahead on their words from their own phone where lanes would stop', async () => {
      const serve = world({ said: ['restart tade'], stops: 2, arm: phone, faceless: true })
      expect(await serve.subject.tools().reload({ said: 'restart tade' })).toBe(stopsAndComeBack(2))
      await waitFor(() => serve.did.some((d) => d.what === 'reloadWindow'))
    })

    it('stops no lanes on a turn that is not their phone’s, since there is no panel to ask at', async () => {
      for (const arm of [
        undefined,
        { how: 'owner', device: 'machine vps' },
        { how: 'remote', device: 'a1b2c3d4e5f60718', projects: null, may: ['answer'] },
      ] as (Arm | undefined)[]) {
        const serve = world({
          said: ['restart tade'],
          stops: 1,
          faceless: true,
          ...(arm ? { arm } : {}),
        })
        await expect(serve.subject.tools().reload({ said: 'restart tade' })).rejects.toThrow(
          '1 lane run inside this Tade and would stop',
        )
        // Refused before anything is put on a clock to start it again.
        expect(serve.did.some((d) => d.what === 'reload' || d.what === 'reloadWindow')).toBe(false)
      }
    })

    it('says nothing would start it again where no service keeps it', async () => {
      const serve = world({ said: ['restart tade'], faceless: true, noReload: true })
      await expect(serve.subject.tools().reload({ said: 'restart tade' })).rejects.toThrow(
        NO_WINDOW,
      )
    })

    it('still asks for their words first', async () => {
      const serve = world({ said: ['how are things'], faceless: true })
      await expect(serve.subject.tools().reload({ said: 'reload' })).rejects.toThrow(
        'Nothing they have said asks for a reload',
      )
    })

    it('runs no update, saying why, and still reads what is current', async () => {
      const serve = world({ asking: true, said: ['install the updates'], faceless: true })
      await expect(
        serve.subject.tools().run({ which: [], said: 'install the updates' }),
      ).rejects.toThrow(RUN_NEEDS_A_SCREEN)
      expect(serve.did.some((d) => d.what === 'terminal')).toBe(false)
      expect(JSON.parse(await serve.subject.tools().read(true))).toMatchObject({ asked: true })
    })
  })

  it('says what the last run did when asked what is current', async () => {
    const one = world({
      asking: true,
      looks: [lookWith({ programs: [program('gh', { behind: true })] })],
    })
    await one.subject.tools().read(true)
    await one.subject.actions()['updates-run']?.('')
    await waitFor(() => one.told.length > 0)
    const read = JSON.parse(await one.subject.tools().read(false)) as {
      lastRun: { said: string }
      updating: unknown
    }
    expect(read.lastRun.said).toBe('Updated gh to 1.1.0.')
    expect(read.updating).toBeNull()
  })
})

async function waitFor(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
