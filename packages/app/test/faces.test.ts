import { describe, expect, it } from 'vitest'
import {
  cannot,
  FACE_OWN,
  FACE_SHARED,
  NOBODY_LOOKING,
  ON_ANOTHER_MACHINE,
  ON_THIS_MACHINE,
  ownFrom,
  ownOf,
  seenBy,
  sharedFrom,
} from '../src/faces.ts'
import { type AppState, initialState } from '../src/model.ts'

// What is whose when a heart has more than one face (`faces.ts`): where a face
// is looking is its own, and everything else is every face's.

/** A state with the machine's own window standing somewhere and the work under way. */
function standing(): AppState {
  return {
    ...initialState(),
    project: 'app',
    focused: 'refunds',
    scroll: 4,
    transcriptScroll: 7,
    known: ['app'],
    orchestratorDraft: 'half a sentence',
  }
}

describe('what is whose', () => {
  it('puts every field of the state in exactly one of the two lists', () => {
    // A field added to `AppState` and to neither list is one nobody decided
    // about: the day a phone scrolls the Mac is the day that field was added.
    const fields = Object.keys(initialState()).sort()
    const own = new Set<string>(FACE_OWN)
    const shared = new Set<string>(FACE_SHARED)
    expect(
      [...own].filter((field) => shared.has(field)),
      'in both lists',
    ).toEqual([])
    expect([...own, ...shared].sort()).toEqual(fields)
  })

  it('draws a face from the heart’s facts and its own place', () => {
    const heart = standing()
    const own = { ...ownOf(heart), focused: 'search', scroll: 0 }
    const seen = seenBy(heart, own)
    expect(seen.focused).toBe('search')
    expect(seen.scroll).toBe(0)
    // The facts are the heart's, the same objects every face draws.
    expect(seen.known).toBe(heart.known)
    expect(seen.transcript).toBe(heart.transcript)
  })

  it('takes what a face wrote apart: the facts for everyone, the machine’s window where it was', () => {
    const heart = standing()
    const theirs = seenBy(heart, { ...ownOf(heart), focused: 'search', project: 'app' })
    const written: AppState = { ...theirs, known: ['app', 'web'], scroll: 9, focused: 'other' }
    const taken = sharedFrom(written, heart)
    expect(taken.known).toEqual(['app', 'web'])
    expect(taken.focused).toBe('refunds')
    expect(taken.scroll).toBe(4)
    expect(ownOf(written).focused).toBe('other')
  })

  it('starts a new face where the machine’s window is, with no hand on anything', () => {
    const heart: AppState = {
      ...standing(),
      hover: { kind: 'project', project: 'app' },
      resizing: 'sidebar',
      leading: true,
      panel: { kind: 'settings' } as AppState['panel'],
    }
    const own = ownFrom(heart)
    expect(own.focused).toBe('refunds')
    expect(own.transcriptScroll).toBe(7)
    expect(own.hover).toBeNull()
    expect(own.resizing).toBeNull()
    expect(own.leading).toBe(false)
    expect(own.panel).toBeNull()
  })
})

describe('what a face can do on its machine', () => {
  it('is everything on the machine’s own window, and says why for anything another cannot', () => {
    for (const what of ['links', 'clipboard', 'editor', 'fronts'] as const) {
      expect(cannot(ON_THIS_MACHINE, what)).toBeNull()
      expect(cannot(ON_ANOTHER_MACHINE, what)).toMatch(/\w{4,}/)
      expect(cannot(NOBODY_LOOKING, what)).toMatch(/\w{4,}/)
    }
  })
})
