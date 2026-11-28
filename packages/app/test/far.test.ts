import { describe, expect, it } from 'vitest'
import { FACE_OWN, ownOf } from '../src/faces.ts'
import {
  type FarMessage,
  type FarWindow,
  farChange,
  farFrame,
  farHeart,
  farWhole,
  frameFrom,
  takeFar,
} from '../src/far.ts'
import { FarFace, lineRows } from '../src/far-face.ts'
import type { Frame } from '../src/frame.ts'
import { keyOutcome } from '../src/keymap.ts'
import { initialState } from '../src/model.ts'
import { PLAIN } from '../src/skin.ts'

// The window's state as it crosses to a phone (`far.ts`), and the phone's
// copy of the window over it (`far-face.ts`): pure, so every case is a table
// rather than a request.

const base = { width: 100, height: 30, skin: PLAIN }

/** A frame as the machine folds one: with what never crosses in it. */
function folded(over: Partial<Frame> = {}): Frame {
  return {
    ...base,
    screen: 'hello',
    now: 1_000,
    clock: (at) => String(at),
    input: { lines: ['the machine’s own line'] },
    held: new Map([['pane', { lane: 'a/agent', lines: ['x'], at: 0 }]]) as unknown as Frame['held'],
    ...over,
  }
}

describe('what crosses', () => {
  it('leaves out what the phone has of its own, and carries a map as its entries', () => {
    const frame = farFrame(folded())
    for (const key of ['width', 'height', 'skin', 'clock', 'date', 'now', 'input']) {
      expect(frame, key).not.toHaveProperty(key)
    }
    expect(frame.held).toEqual([['pane', { lane: 'a/agent', lines: ['x'], at: 0 }]])
    // And it is plain data: what is sent is what arrives.
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
    // Built back at the phone's size and in its skin, the map a map again.
    const back = frameFrom({ rev: 1, heart: farHeart(initialState()), frame }, base)
    expect(back.held?.get('pane')?.lane).toBe('a/agent')
    expect(back.width).toBe(100)
  })

  it('sends the facts of the state and none of where a face looks', () => {
    const heart = farHeart(initialState())
    for (const key of FACE_OWN) expect(heart, key).not.toHaveProperty(key)
  })
})

describe('a whole, and what moved since', () => {
  const state = initialState()
  const heart = farHeart(state)

  it('sends nothing where nothing moved, even from a frame made again', () => {
    const { sent } = farWhole(1, heart, farFrame(folded()), ownOf(state))
    // Made again: new objects, the same values, and another moment.
    expect(
      farChange(sent, 2, farHeart({ ...state }), farFrame(folded({ now: 9_999 })), {}),
    ).toBeNull()
  })

  it('sends a list that grew as its tail, and the phone puts it back together', () => {
    const one = { kind: 'tade' as const, text: 'one', at: 1 }
    const two = { kind: 'tade' as const, text: 'two', at: 2 }
    const was = { ...state, transcript: { ...state.transcript, entries: [one] } } as typeof state
    const is = {
      ...state,
      transcript: { ...state.transcript, entries: [one, two] },
    } as typeof state
    // The transcript is one field; a list inside it is sent whole, and a list
    // that is the field — the panes — as its tail.
    const panes = [{ task: 'a' }, { task: 'b' }] as unknown as typeof state.panes
    const more = [...panes, { task: 'c' }] as unknown as typeof state.panes
    const first = farWhole(1, farHeart({ ...was, panes }), farFrame(folded()), ownOf(state))
    const change = farChange(
      first.sent,
      2,
      farHeart({ ...is, panes: more }),
      farFrame(folded()),
      {},
    )
    expect(change).not.toBeNull()
    expect(change?.message.heart?.panes).toEqual({ at: 2, v: [{ task: 'c' }] })
    const held = takeFar(null, first.message)
    const taken = held && change ? takeFar(held.window, change.message) : null
    expect(taken?.window.heart.panes).toEqual(more)
    expect(taken?.window.heart.transcript.entries).toEqual([one, two])
  })

  it('says a frame field that went, and a phone that missed a change asks for a whole', () => {
    const first = farWhole(1, heart, farFrame(folded({ orchestrator: 'its screen' })), ownOf(state))
    const change = farChange(first.sent, 2, heart, farFrame(folded()), {})
    expect(change?.message.gone).toEqual(['orchestrator'])
    const held = takeFar(null, first.message)
    expect(held && change && takeFar(held.window, change.message)?.window.frame).not.toHaveProperty(
      'orchestrator',
    )
    // A change against a revision the phone does not hold cannot be built on.
    const behind: FarWindow = { rev: 7, heart, frame: farFrame(folded()) }
    expect(change && takeFar(behind, change.message)).toBeNull()
    expect(change && takeFar(null, change.message)).toBeNull()
  })

  it('hands back where the machine moved the face, and nothing else of it', () => {
    const first = farWhole(1, heart, farFrame(folded()), ownOf(state))
    const change = farChange(first.sent, 2, heart, farFrame(folded()), {
      panel: null,
      focused: 'a',
    })
    const held = takeFar(null, first.message)
    expect(held && change && takeFar(held.window, change.message)?.own).toEqual({
      panel: null,
      focused: 'a',
    })
  })
})

describe('the phone’s face', () => {
  /** A phone holding the window whole. */
  function holding(): FarFace {
    const face = new FarFace({ machine: 'the Mac' })
    const state = initialState()
    const message: FarMessage = farWhole(
      1,
      farHeart(state),
      farFrame(folded()),
      ownOf(state),
    ).message
    expect(face.take(message)).toBe(true)
    return face
  }

  it('draws nothing before it has the window, and draws it once it does', () => {
    expect(new FarFace().draw(base)).toBeNull()
    const drawn = holding().draw(base)
    expect(drawn?.rows.length).toBeGreaterThan(0)
  })

  it('answers a key the window keeps as the machine’s own keyboard would, and asks nothing for it', () => {
    const face = holding()
    // F1 is the keys sheet: a button's action, which only the machine runs.
    const pressed = face.key('\x1bOP')
    expect(pressed.intents).toEqual([{ kind: 'run', action: 'keys' }])
  })

  it('types on its own line, and Enter sends what is on it', () => {
    const face = holding()
    // Nothing in front: the orchestrator is, and typing opens the line.
    const typed = ['h', 'i'].map((key) => face.key(key))
    // The line is this phone's, so opening it asks the machine for nothing.
    expect(typed.flatMap((one) => one.intents)).toEqual([])
    expect(face.typing()).toBe('hi')
    expect(face.key('\x7f').intents).toEqual([])
    expect(face.typing()).toBe('h')
    expect(face.key('\r').intents).toEqual([{ kind: 'say', said: 'h' }])
    expect(face.typing()).toBe('')
    // And Enter on an empty line sends nothing.
    expect(face.key('\r').intents).toEqual([])
  })

  it('keeps the last window when the connection drops, and says it is stale until a message lands', () => {
    const face = holding()
    face.lost(5)
    expect(face.stale).toBe(5)
    const stale = face.draw(base)?.rows.join('\n') ?? ''
    expect(stale).toContain('the Mac cannot be reached')
    const state = initialState()
    face.take(farWhole(2, farHeart(state), farFrame(folded()), ownOf(state)).message)
    expect(face.stale).toBeNull()
    expect(face.draw(base)?.rows.join('\n')).not.toContain('cannot be reached')
  })

  it('draws its line with a rule above and below and the caret on the character under it', () => {
    const rows = lineRows({ text: 'ab', caret: 1 }, 10, PLAIN)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toBe(' a\x1b[7mb\x1b[27m       ')
  })
})

describe('the keymap', () => {
  it('moves the face for what is where it looks, and asks the machine for what it does', () => {
    const state = initialState()
    expect(keyOutcome({ kind: 'lead' }, state, 0)?.state?.leading).toBe(true)
    expect(keyOutcome({ kind: 'approve' }, state, 0)?.does).toEqual({ kind: 'decide', allow: true })
    expect(keyOutcome({ kind: 'run', action: 'settings' }, state, 0)?.does).toEqual({
      kind: 'run',
      action: 'settings',
    })
    expect(keyOutcome({ kind: 'help' }, state, 7)?.state?.notice).toContain('tab switches')
    // What the caller does with its own line and its own way into a lane.
    for (const kind of ['lead-through', 'complete', 'leave-line', 'discard', 'none'] as const) {
      expect(keyOutcome({ kind }, state, 0), kind).toBeNull()
    }
  })
})
