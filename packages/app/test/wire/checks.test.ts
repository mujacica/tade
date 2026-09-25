import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { ActionsView, Frame } from '../../src/frame.ts'
import type { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { Checks } from '../../src/wire/checks.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The window's end of "a check that nobody ran is not a check that passed":
// the button that runs a task's checks, and the tail of what one printed.
//
// Built by hand rather than through the harness, unlike the rest of this
// folder. The whole of this subject is *what it asks the extension host for* —
// three tool calls, the caller each is made as, and what it puts in the
// conversation about them — and a real window would answer that question with
// a real workbench and a real repository standing behind it. What the other
// files here are for is that a keystroke reaches the subject; this is what the
// subject does once it has.
//
// Nothing in it decides anything about a check: the run goes through the same
// `checks_run` the orchestrator and `tade check` use, so the worktree's lock,
// the record and the row come free — four agents in one checkout must never
// start four suites, and the way to keep that true is to have no second path.

interface Call {
  tool: string
  input: Record<string, unknown>
  caller: unknown
}

/** A window for this subject to live in, and everything it did to it. */
function wiring(
  over: {
    host?: { answer?: string; fails?: string } | null
    live?: Partial<Live>
    now?: number
  } = {},
) {
  const calls: Call[] = []
  let draws = 0
  let state: AppState = initialState()
  const host =
    over.host === null
      ? null
      : {
          async call(tool: string, input: Record<string, unknown>, ctx: { caller: unknown }) {
            calls.push({ tool, input, caller: ctx.caller })
            if (over.host?.fails) throw new Error(over.host.fails)
            return { text: over.host?.answer ?? 'done' }
          },
        }
  const wire = {
    opts: {
      config: ConfigSchema.parse({}),
      extensions: host,
      extensionWorkbench: null,
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: (over.live ?? null) as Live | null,
    now: () => over.now ?? 1_000,
    openedAt: 0,
    draw: () => {
      draws += 1
    },
    note: (err: unknown) => {
      state = { ...state, notice: err instanceof Error ? err.message : String(err) } as AppState
    },
  } as unknown as Wiring
  return {
    wire,
    calls,
    at: () => state,
    drawn: () => draws,
  }
}

const sections =
  (rows: unknown[] = []) =>
  () =>
    [{ title: 'REVIEWS', rows }] as unknown as Parameters<
      ConstructorParameters<typeof Checks>[1]['sections']
    > extends never
      ? never
      : ReturnType<ConstructorParameters<typeof Checks>[1]['sections']>

const deps = (rows: unknown[] = []) => ({
  sections: sections(rows),
  callId: () => 'call-1',
})

const seen = (over: Partial<ActionsView> = {}): ActionsView =>
  ({
    task: 'shop/refunds',
    branch: 'tade/refunds',
    base: 'main',
    ahead: 1,
    behind: 0,
    dirty: 0,
    shared: false,
    commit: 'abc1234',
    mine: [],
    others: [],
    review: null,
    checks: [{ id: 'tests' }, { id: 'types' }],
    running: null,
    ...over,
  }) as unknown as ActionsView

describe('what a task has done, while a run this window started is going', () => {
  it('says a run is going the moment it is asked for, not when it writes something', async () => {
    const world = wiring({
      live: { actions: () => seen(), worktreeOf: () => null, hurryUp: () => {} } as never,
    })
    const checks = new Checks(world.wire, deps())

    const going = checks.run('shop/refunds')
    // Between the press and the first check starting, the record says nothing
    // — and a button that does nothing for a second is a button people press
    // twice, which is four suites in one checkout.
    const view = checks.actionsFor(world.wire.live as Live, 'shop/refunds')
    expect(view?.running).toEqual({ since: 1_000, by: 'you', done: 0, total: 2 })
    await going
  })

  it('leaves a run the record already knows about exactly as it found it', () => {
    const real = { since: 5, by: 'an agent', done: 1, total: 2 }
    const world = wiring({
      live: { actions: () => seen({ running: real as never }) } as never,
    })
    const checks = new Checks(world.wire, deps())
    expect(checks.actionsFor(world.wire.live as Live, 'shop/refunds')?.running).toBe(real)
  })

  it('says nothing about a task the world has nothing for', () => {
    const world = wiring({ live: { actions: () => null } as never })
    expect(new Checks(world.wire, deps()).actionsFor(world.wire.live as Live, 'x/y')).toBeNull()
  })
})

describe('the review the branch is out for', () => {
  const row = {
    task: 'shop/refunds',
    // As `review/format.ts` writes one: the forge's own word for a number,
    // then two spaces, then the title.
    title: '#412  Cover the wire',
    links: [{ url: 'https://example.com/412' }],
    marks: [{ text: 'checks failed', tone: 'bad' }],
  }

  it('reads it out of the list the forge extension keeps, and never asks a forge', () => {
    const world = wiring()
    expect(new Checks(world.wire, deps([row])).review('shop/refunds')).toEqual({
      number: '#412',
      title: 'Cover the wire',
      url: 'https://example.com/412',
      marks: [{ text: 'checks failed', tone: 'bad' }],
    })
  })

  it('says nothing about a task no list mentions', () => {
    const world = wiring()
    expect(new Checks(world.wire, deps([row])).review('shop/vat')).toBeNull()
  })

  it('says nothing at all where the project asked not to be told about CI', () => {
    const world = wiring()
    ;(world.wire.opts as unknown as { config: unknown }).config = ConfigSchema.parse({
      checks: { ci: false },
    })
    // With `checks.ci` off the ACTIONS tab is the local run and nothing else:
    // a row about somebody's CI is exactly what was turned off.
    expect(new Checks(world.wire, deps([row])).review('shop/refunds')).toBeNull()
  })
})

describe('running a task’s checks', () => {
  it('runs them in the task’s own worktree, as that task', async () => {
    const world = wiring({
      live: {
        worktreeOf: () => '/tmp/wt/refunds',
        hurryUp: () => {},
        actions: () => null,
      } as never,
    })
    await new Checks(world.wire, deps()).run('shop/refunds')
    expect(world.calls).toEqual([
      {
        tool: 'checks_run',
        input: { project: 'shop' },
        caller: { kind: 'agent', task: 'shop/refunds', project: 'shop', cwd: '/tmp/wt/refunds' },
      },
    ])
  })

  it('runs them as you where the task has no worktree of its own', async () => {
    const world = wiring({
      live: { worktreeOf: () => null, hurryUp: () => {}, actions: () => null } as never,
    })
    await new Checks(world.wire, deps()).run('shop/refunds')
    expect(world.calls[0]?.caller).toEqual({ kind: 'you' })
  })

  it('never starts a second suite over the first', async () => {
    let release = () => {}
    const waiting = new Promise<void>((done) => {
      release = done
    })
    const world = wiring({ live: { worktreeOf: () => null, hurryUp: () => {} } as never })
    ;(world.wire.opts as unknown as { extensions: unknown }).extensions = {
      async call(tool: string, input: Record<string, unknown>, ctx: { caller: unknown }) {
        world.calls.push({ tool, input, caller: ctx.caller })
        await waiting
        return { text: 'ok' }
      },
    }
    const checks = new Checks(world.wire, deps())

    const first = checks.run('shop/refunds')
    await checks.run('shop/refunds')
    // Four agents in one checkout must never start four suites, and the second
    // press is the commonest way that happens.
    expect(world.calls).toHaveLength(1)
    expect(world.at().notice).toContain('already running its checks')

    release()
    await first
  })

  it('lets go of the task when a run fails, so it can be pressed again', async () => {
    const world = wiring({
      host: { fails: 'another run holds this checkout' },
      live: { worktreeOf: () => null, hurryUp: () => {} } as never,
    })
    const checks = new Checks(world.wire, deps())
    await checks.run('shop/refunds')
    expect(world.at().notice).toContain('another run holds this checkout')

    await checks.run('shop/refunds')
    // Not left marked as going for ever, which is a button that never works again.
    expect(world.calls).toHaveLength(2)
  })

  it('asks the world to look often while it goes', async () => {
    const hurried: string[] = []
    const world = wiring({
      live: { worktreeOf: () => null, hurryUp: (task: string) => hurried.push(task) } as never,
    })
    await new Checks(world.wire, deps()).run('shop/refunds')
    // A suite takes minutes; the page has to say which check is going rather
    // than nothing for ten seconds.
    expect(hurried).toEqual(['shop/refunds'])
  })

  it('says so plainly where no extensions are loaded', async () => {
    const world = wiring({ host: null })
    await new Checks(world.wire, deps()).run('shop/refunds')
    expect(world.at().notice).toContain('no extensions are loaded')
  })
})

describe('reading what one check printed', () => {
  it('asks for the tail and opens the conversation to put it in', async () => {
    const world = wiring({
      live: { worktreeOf: () => '/tmp/wt/refunds' } as never,
    })
    await new Checks(world.wire, deps()).show('shop/refunds', 'tests')
    expect(world.calls).toEqual([
      {
        tool: 'checks_log',
        input: { check: 'tests', project: 'shop' },
        caller: { kind: 'agent', task: 'shop/refunds', project: 'shop', cwd: '/tmp/wt/refunds' },
      },
    ])
    // Opened, because the answer is the tail of a failure and the strip has
    // one line.
    expect(world.at().bottomMode).not.toBe('min')
  })

  it('says what went wrong rather than throwing out of a click', async () => {
    const world = wiring({
      host: { fails: 'no run of tests here yet' },
      live: { worktreeOf: () => null } as never,
    })
    await new Checks(world.wire, deps()).show('shop/refunds', 'tests')
    expect(world.at().notice).toContain('no run of tests here yet')
  })

  it('does nothing at all where no extensions are loaded', async () => {
    const world = wiring({ host: null })
    await new Checks(world.wire, deps()).show('shop/refunds', 'tests')
    expect(world.drawn()).toBe(0)
  })
})

describe('the actions it answers', () => {
  it('names one action per button the ACTIONS tab draws', () => {
    const world = wiring()
    expect(Object.keys(new Checks(world.wire, deps()).actions()).sort()).toEqual([
      'check-log:',
      'checks-run:',
    ])
  })

  it('reads a check log action as a task and a check', async () => {
    const world = wiring({ live: { worktreeOf: () => null } as never })
    const checks = new Checks(world.wire, deps())
    await checks.actions()['check-log:']?.('shop/refunds\u0000types')
    expect(world.calls[0]?.input).toEqual({ check: 'types', project: 'shop' })
  })

  it('does nothing with a check log action that names only half of one', async () => {
    const world = wiring({ live: { worktreeOf: () => null } as never })
    await new Checks(world.wire, deps()).actions()['check-log:']?.('shop/refunds')
    expect(world.calls).toEqual([])
  })

  it('offers the ACTIONS tab for whatever is in front of you, and nothing before the first look', () => {
    const world = wiring()
    expect((new Checks(world.wire, deps()).facts() as Partial<Frame>).actions).toBeNull()
  })
})
