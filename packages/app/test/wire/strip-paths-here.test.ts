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
// and then a path in them is that machine's, as one on its agent's screen is.

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

/** The window's mouse over that state, saying what a press asked for. */
function pressed(state: AppState, target: Target): { ran: string[]; opened: string[] } {
  const ran: string[] = []
  const opened: string[] = []
  const wire = { state, put() {}, draw() {} }
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
  new Mouse(wire as never, deps as MouseDeps).clicked(target)
  return { ran, opened }
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
    const talk = {
      machine: 'vps',
      transcript: said(emptyTranscript(), SAID, 0),
      missed: null,
      says: { said: '', tone: 'hint' as const },
    }
    const [place] = places(draw(state, frame({ talk })).hits)
    expect(place).toMatchObject({ kind: 'place', path: 'packages/app/src/links.ts' })
    expect(place && 'here' in place).toBe(false)
    if (!place) throw new Error('no path in its tab')
    // Read there, as a path on that machine's agent's screen always was.
    expect(pressed(state, place)).toEqual({
      ran: ['remote-there:place\0packages/app/src/links.ts\x0012'],
      opened: [],
    })
  })
})
