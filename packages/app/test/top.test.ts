import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import {
  type AppState,
  initialState,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { NO_POINTER } from '../src/ui.ts'
import { projectStandings, renderTop } from '../src/view/top.ts'

// What the row along the top says about the projects you are not looking at.
//
// Two projects and two plain names said nothing at all: which one the spinner
// at the right belonged to, whether anything in the other wanted you, whether
// what you asked for in it was finished. Each tab carries its own marks now,
// and the figures at the right say whose they are.

const frame = (over: Partial<Frame> = {}): Frame =>
  ({
    width: 160,
    height: 24,
    screen: '',
    skin: COLOUR,
    now: 0,
    voice: { keys: ['ctrl', 'space'], available: true },
    ...over,
  }) as Frame

const world = (tasks: TaskSnapshot[], projects = ['checkout', 'search', 'infra']): AppState =>
  withTasks(withProjects(initialState(), projects), tasks)

const strip = (state: AppState, width = 160): string =>
  stripTerminalSequences(
    renderTop(state, frame({ width }), width, COLOUR, NO_POINTER).rows[0] ?? '',
  )

const working: TaskSnapshot = {
  task: 'checkout/refunds',
  state: 'working',
  lane: 'checkout/refunds/agent',
}
const wantsYou: TaskSnapshot = {
  task: 'checkout/stripe-v15',
  state: 'blocked',
  lane: 'checkout/stripe-v15/agent',
  waiting: true,
  approval: { tool: 'bash', summary: 'npm i stripe@15' },
}
const finished: TaskSnapshot = { task: 'search/pagination', state: 'review' }
const held: TaskSnapshot = {
  task: 'infra/rotate-keys',
  state: 'queued',
  queued: {
    state: { kind: 'held', on: 'infra/bump-node', because: 'infra/bump-node failed' },
    after: [{ task: 'infra/bump-node', why: 'both change the Dockerfile' }],
    prompt: 'Rotate the deploy keys.',
    touches: ['deploy/'],
    at: null,
  },
}

describe('what a project tab counts', () => {
  it('reads every mark the agent list reads, project by project', () => {
    const standings = projectStandings(world([working, wantsYou, finished]))
    expect(standings.get('checkout')?.counts).toMatchObject({ working: 1, 'needs-you': 1, done: 0 })
    expect(standings.get('search')?.counts).toMatchObject({ done: 1, working: 0 })
    // Nothing has been asked of it, so it has no standing at all — which is
    // not the same as everything in it being finished.
    expect(standings.get('infra')).toBeUndefined()
  })

  it('counts queued work, which is not an agent and has no mark of its own', () => {
    const queued: TaskSnapshot = {
      task: 'infra/tidy-logs',
      state: 'queued',
      queued: {
        state: { kind: 'ready' },
        after: [],
        prompt: 'Tidy the logs.',
        touches: [],
        at: null,
      },
    }
    const standings = projectStandings(world([queued]))
    expect(standings.get('infra')?.counts.queued).toBe(1)
    expect(standings.get('infra')?.counts.stopped).toBe(0)
  })

  it('counts held work as something waiting on you, the way the queue draws it', () => {
    const standings = projectStandings(world([held]))
    expect(standings.get('infra')?.counts['needs-you']).toBe(1)
    expect(standings.get('infra')?.counts.queued).toBe(0)
  })

  it('counts paused work as set aside, not as waiting its turn', () => {
    const paused: TaskSnapshot = {
      ...held,
      queued: { ...held.queued!, state: { kind: 'paused', all: false } },
    }
    expect(projectStandings(world([paused])).get('infra')?.counts.parked).toBe(1)
  })

  it('settles only where something finished and nothing is left', () => {
    const all = projectStandings(world([working, finished]))
    expect(all.get('search')?.settled).toBe(true)
    expect(all.get('checkout')?.settled).toBe(false)
    // A turn that ended is not a task that finished: an idle agent holds it open.
    const idle: TaskSnapshot = { task: 'search/rankings', state: 'blocked', reason: 'idle' }
    expect(projectStandings(world([finished, idle])).get('search')?.settled).toBe(false)
  })
})

describe('the project tabs', () => {
  it('says what is happening in each one, in marks and counts', () => {
    const text = strip(world([working, wantsYou, finished, held]))
    expect(text).toContain('checkout ! ⠋')
    expect(text).toContain('search ✓')
    expect(text).toContain('infra !')
  })

  it('answers "is everything I asked for done in there?" without going there', () => {
    expect(strip(world([working, finished]))).toContain('search ✓')
  })

  it('says nothing about a project nothing has been asked of', () => {
    const text = strip(world([working]))
    // Its own buttons after it and then the `+`, and nothing between the name
    // and them: no mark, no count, no tick.
    expect(text).toMatch(/infra\s+×\s+≡\s+\+/)
  })

  it('counts where a count is a number you could not have guessed', () => {
    const more: TaskSnapshot[] = [
      working,
      { task: 'checkout/mailer', state: 'working', lane: 'checkout/mailer/agent' },
      { task: 'checkout/ledger', state: 'working', lane: 'checkout/ledger/agent' },
    ]
    expect(strip(world(more))).toContain('checkout ⠋3')
    expect(strip(world([working]))).toContain('checkout ⠋')
  })

  it('gives up its counts, then all but its busiest mark, as the room runs out', () => {
    const state = world([working, wantsYou, finished, held])
    const said = (width: number) => strip(state, width)
    expect(said(160)).toContain('checkout ! ⠋')
    // Narrower: the marks lose the spaces between them, then everything but
    // the first — which is the most urgent, because that is the order.
    expect(said(120)).toContain('checkout !⠋')
    expect(said(96)).not.toContain('checkout !⠋')
    expect(said(96)).toMatch(/checkout !\s/)
  })
})

describe('the figures at the right', () => {
  it('says whose they are where there is more than one project', () => {
    expect(strip(world([working, wantsYou]))).toContain('in checkout')
    expect(strip(world([working, { ...wantsYou, task: 'search/pagination' }]))).toContain(
      'in 2 projects',
    )
  })

  it('names the project the spinner belongs to, not the one you are in', () => {
    const text = strip(world([{ ...working, task: 'search/pagination' }]))
    expect(text).toContain('in search')
  })

  it('leaves the clause off where there is only one project to mean', () => {
    const text = strip(world([working, wantsYou], ['checkout']))
    expect(text).toContain('1 working')
    expect(text).not.toContain(' in ')
  })

  it('draws no total at all where there is no room to say whose it is', () => {
    // A figure nobody can place is the spinner this started as: short of room
    // the total is what goes, and the tabs carry the answer alone.
    const text = strip(world([working, wantsYou, finished]), 96)
    expect(text).not.toContain('! 1')
    expect(text).toContain('checkout !')
    expect(text).toContain('search ✓')
  })
})
