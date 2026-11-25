import { describe, expect, it } from 'vitest'
import type { Frame } from '../../src/frame.ts'
import type { Hit, Target } from '../../src/hits.ts'
import { type AppState, initialState, withProjects } from '../../src/model.ts'
import { emptyTranscript, said } from '../../src/transcript.ts'
import { draw } from '../../src/view.ts'
import { Mouse, type MouseDeps } from '../../src/wire/mouse.ts'

// A path in this machine's own conversation, pressed while you stand in a
// project on another machine.
//
// The strip at the foot is this machine's orchestrator wherever you stand, so
// a file it names is on this disk: pressing it opens it here. Only another
// machine's orchestrator's tab in front puts that machine's words in the strip,
// and then a path in them is that machine's wherever you stand: read there
// while you stand in one of its projects, and never opened on this disk, or on
// a third machine's, in its place.

const SAID = 'I changed packages/app/src/links.ts:12 for it'

const standing = (): AppState => ({
  ...withProjects(initialState(), ['app']),
  transcript: said(emptyTranscript(), SAID, 0),
  focused: null,
  elsewhere: { machine: 'vps', project: 'tade' },
})

const places = (hits: readonly Hit[]) =>
  hits.map((hit) => hit.target).filter((target) => target.kind === 'place')

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 30,
  screen: '',
  ...over,
})

const talk = {
  machine: 'vps',
  transcript: said(emptyTranscript(), SAID, 0),
  missed: null,
  says: { said: '', tone: 'hint' as const },
}

/** The window's mouse over that state, saying what a press asked for and what the window said. */
function pressed(
  state: AppState,
  target: Target,
  button: 'left' | 'right' = 'left',
): { ran: string[]; opened: string[]; notice?: string | null } {
  const ran: string[] = []
  const opened: string[] = []
  const wire = {
    state,
    put(next: AppState) {
      wire.state = next
    },
    draw() {},
    now: () => 0,
  }
  const deps: Partial<MouseDeps> = {
    run: (name) => {
      ran.push(name)
    },
    openFile: (path) => {
      opened.push(path)
    },
    resolvePath: (path) => `/here/${path}`,
    openMenu: () => {
      ran.push('menu')
    },
  }
  new Mouse(wire as never, deps as MouseDeps).clicked(target, button)
  return wire.state.notice ? { ran, opened, notice: wire.state.notice } : { ran, opened }
}

/** The path in the strip, with the machine's tab in front where `tab`. */
function placeIn(state: AppState, tab: boolean): Target {
  const [place] = places(draw(state, frame(tab ? { talk } : {})).hits)
  if (!place) throw new Error('no path in the strip')
  return place
}

describe('a path in this machine’s own conversation, standing on another machine', () => {
  it('is drawn as this machine’s, and opened here when pressed', () => {
    const state = standing()
    const [place] = places(draw(state, frame()).hits)
    expect(place).toMatchObject({ kind: 'place', path: 'packages/app/src/links.ts', line: 12 })
    expect(place).toMatchObject({ here: true })
    if (!place) throw new Error('no path in the strip')
    expect(pressed(state, place)).toEqual({
      ran: [],
      opened: ['/here/packages/app/src/links.ts'],
    })
  })

  it('is that machine’s in its orchestrator’s tab, and in its agent’s screen', () => {
    const state: AppState = { ...standing(), bottom: 'talk:vps' }
    const place = placeIn(state, true)
    expect(place).toMatchObject({ kind: 'place', path: 'packages/app/src/links.ts', there: 'vps' })
    expect('here' in place).toBe(false)
    // Read there, as a path on that machine's agent's screen always was.
    expect(pressed(state, place)).toEqual({
      ran: ['remote-there:place\0packages/app/src/links.ts\x0012'],
      opened: [],
    })
  })

  it('is that machine’s in its orchestrator’s tab while you stand in a project here', () => {
    const state: AppState = { ...standing(), elsewhere: null, bottom: 'talk:vps' }
    const place = placeIn(state, true)
    expect(place).toMatchObject({ there: 'vps' })
    const said = 'packages/app/src/links.ts is on vps: stand in one of its projects to open it'
    // Nothing on this disk is opened, and no menu of this disk's is offered.
    expect(pressed(state, place)).toEqual({ ran: [], opened: [], notice: said })
    expect(pressed(state, place, 'right')).toEqual({ ran: [], opened: [], notice: said })
  })

  it('is that machine’s in its orchestrator’s tab while you stand on a third machine', () => {
    const state: AppState = {
      ...standing(),
      elsewhere: { machine: 'mac', project: 'tade' },
      bottom: 'talk:vps',
    }
    // Never read from the machine you stand on, which did not say it.
    expect(pressed(state, placeIn(state, true))).toEqual({
      ran: [],
      opened: [],
      notice: 'packages/app/src/links.ts is on vps: stand in one of its projects to open it',
    })
  })
})
