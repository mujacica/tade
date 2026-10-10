import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { QUEUE_ASKS as ASKS, BOUNDS, HOWS } from '../src/acting.ts'
import {
  actsOf,
  afterAnswer,
  bodyFor,
  confirms,
  controlsFor,
  headingFor,
  howSaid,
  NEEDS,
  QUEUE_ASKS,
  SHOWN,
  standingOf,
  wordsFor,
} from '../src/assets/acts.js'
import { draftStore, reasonFor, saidOn, whoSaid } from '../src/assets/talk.js'
import { ERRORS } from '../src/errors.ts'
import { VERBS, verbFor } from '../src/verbs.ts'
import { task } from './fixtures.ts'

// The page's own rules about what it offers, and the three copies held equal.
//
// A browser cannot import a `.ts` file and this repository has no build step,
// so which scope each verb needs exists in `verbs.ts` for the machine and in
// `acts.js` for the page. The alternative is a bundler for one table. What
// makes two copies safe is this file: the same table through both, asserted
// equal — the pattern `inScope`/`appliesTo` and `live.js`/`stream.ts` already
// use.
//
// The rest is what a renderer cannot be tested for in this repository. There is
// no DOM in its `lib` and no jsdom in its lockfile, so the *decisions* a
// control makes are pure functions in `acts.js` and this is where they are
// asked — and `scripts/browser.ts` drives the nodes they build in a real
// browser, with a real tap and a real keyboard.

const ROW = {
  id: 'sentry/away-steer',
  rev: 'p0.a1.q0.g1.f0.kready',
  parked: false,
  approval: { id: 'req-1', tool: 'Bash', since: '2026-10-09T00:00:00.000Z' },
  can: [
    { verb: 'answer', how: 'now' },
    { verb: 'steer', how: 'next-turn' },
    { verb: 'note', how: 'now' },
  ],
  cannot: [
    { verb: 'queue', why: 'it is not queued work' },
    { verb: 'intake', why: 'it did not come from outside this machine' },
  ],
}

const BOTH = { answer: true, steer: true }

describe('the scope each verb needs, written twice', () => {
  it('agrees with the verb table, verb for verb', () => {
    // **Both directions.** A verb the page knows and the table does not is a
    // control that is always refused; a verb the table has and the page does
    // not is one nobody can reach from a phone. Either is silent.
    expect(Object.keys(NEEDS).sort()).toEqual(VERBS.map((verb) => verb.name).sort())
    for (const verb of VERBS) expect(NEEDS[verb.name], verb.name).toBe(verb.needs)
    for (const verb of SHOWN) expect(verbFor(verb), verb).not.toBeNull()
  })

  it('draws a control for every verb there is, and for nothing else', () => {
    expect([...SHOWN].sort()).toEqual(VERBS.map((verb) => verb.name).sort())
  })

  it('offers the queue the queue’s own words, and never an order', () => {
    // `order` is the one choice a device may never ask for: a list of task ids
    // in a body could reorder work in a project this device cannot see, so
    // `first` is the page's word for it and the list is computed at the
    // machine.
    expect(QUEUE_ASKS.map((one) => one.change).sort()).toEqual([...ASKS].sort())
    expect(QUEUE_ASKS.map((one) => one.change)).not.toContain('order')
    for (const one of QUEUE_ASKS) expect(one.said.length).toBeGreaterThan(3)
  })

  it('says what a wait means in words, for every way the wire can say one', () => {
    // Each of the three the projection may send, turned into a clause rather
    // than drawn as a code. `now` has nothing to add, which is the one that
    // must come back empty: a control saying *now* beside it is noise on every
    // row.
    expect(howSaid('now')).toBe('')
    for (const how of HOWS.filter((one) => one !== 'now')) {
      expect(howSaid(how).length, how).toBeGreaterThan(4)
    }
    expect(howSaid('something else')).toBe('')
  })
})

describe('what this device may draw', () => {
  it('reads the scopes off its own session, and nothing off a row', () => {
    expect(actsOf({ scopes: ['read', 'steer'] })).toEqual({
      answer: false,
      steer: true,
      ask: false,
      draft: false,
    })
    expect(actsOf({ scopes: ['read', 'answer'] })).toEqual({
      answer: true,
      steer: false,
      ask: false,
      draft: false,
    })
    expect(actsOf({ scopes: ['read', 'answer', 'steer'] })).toEqual({
      ...BOTH,
      ask: false,
      draft: false,
    })
    // **A third scope, and neither tier implies it.** A device granted both
    // acting tiers has been granted eight bounded verbs; talking to a model
    // that holds tools is a separate grant with a separate control.
    expect(actsOf({ scopes: ['read', 'ask'] })).toEqual({
      answer: false,
      steer: false,
      ask: true,
      draft: false,
    })
    // **And a fourth, implied by nothing and implying nothing.** Saving a
    // field of a draft workflow writes a file every future run would be
    // stamped from once somebody at the machine publishes it, so it is its own
    // grant with its own control — and a device granted it has not been
    // granted either acting tier or a word to the model.
    expect(actsOf({ scopes: ['read', 'draft'] })).toEqual({
      answer: false,
      steer: false,
      ask: false,
      draft: true,
    })
  })

  it('draws nothing for a session that is not there, or carries nothing', () => {
    // Every shape a session can be missing in, because a default of *may* here
    // would be a control present and refused on every row of a read-only
    // phone.
    for (const session of [null, undefined, {}, { scopes: null }, { scopes: 'steer' }]) {
      expect(actsOf(session), JSON.stringify(session)).toEqual({
        answer: false,
        steer: false,
        ask: false,
        draft: false,
      })
    }
  })
})

describe('whether one control is drawn, and what is said instead', () => {
  it('says nothing at all about a verb this device was not granted', () => {
    // **`off` draws no reason**, which is the one of the three that is about
    // somebody else: a sentence naming a scope this device does not have is a
    // map of what else there is to ask for.
    const only = { answer: true, steer: false }
    expect(standingOf('steer', ROW, only)).toEqual({ kind: 'off', why: '' })
    expect(standingOf('note', ROW, only)).toEqual({ kind: 'off', why: '' })
    expect(standingOf('answer', ROW, only).kind).toBe('yes')
  })

  it('draws the row’s own reason where the thing cannot be done', () => {
    expect(standingOf('queue', ROW, BOTH)).toEqual({
      kind: 'no',
      why: 'it is not queued work',
    })
  })

  it('carries how it would happen, so a wait is said before somebody types', () => {
    expect(standingOf('steer', ROW, BOTH)).toEqual({ kind: 'yes', how: 'next-turn', why: '' })
    expect(standingOf('answer', ROW, BOTH)).toEqual({ kind: 'yes', how: 'now', why: '' })
  })

  it('is `no` with no sentence for a verb the row mentions in neither list', () => {
    // A row from an older server, or one this page knows a verb the projection
    // does not. **Absent**, which is the safe direction: a control drawn on a
    // row that said nothing about it is one nothing could carry out.
    expect(standingOf('done', ROW, BOTH)).toEqual({ kind: 'no', why: '' })
    expect(standingOf('park', { can: [], cannot: [] }, BOTH)).toEqual({ kind: 'no', why: '' })
  })

  it('is `no` for a row with no lists at all, and never throws', () => {
    for (const row of [{}, { can: null, cannot: null }]) {
      expect(standingOf('park', row, BOTH).kind, JSON.stringify(row)).toBe('no')
    }
  })

  it('walks every verb once, in the order the page draws them', () => {
    const made = controlsFor(ROW, BOTH)
    expect(made.map((one) => one.verb)).toEqual([...SHOWN])
    expect(new Set(made.map((one) => one.verb)).size).toBe(SHOWN.length)
  })

  it('has a heading for every verb, and a word for every one with a single press', () => {
    for (const verb of SHOWN) expect(headingFor(verb), verb).toMatch(/^[A-Z ]+$/)
    // `queue` is the one with no single press: its five choices each carry
    // their own word, so a word here would be one nobody ever sees. Empty
    // rather than a plausible default, which is how a control ends up
    // labelled *Do it*.
    expect(SHOWN.filter((verb) => wordsFor(verb, ROW) === '')).toEqual(['queue'])
    for (const verb of SHOWN.filter((one) => one !== 'queue')) {
      expect(wordsFor(verb, ROW).length, verb).toBeGreaterThan(3)
    }
    // The one that reads both ways, because park is one toggle.
    expect(wordsFor('park', { parked: false })).toBe('Set this aside')
    expect(wordsFor('park', { parked: true })).toBe('Pick this back up')
    // And the one that names what it is answering, so nobody allows blind.
    expect(wordsFor('answer', ROW)).toBe('Allow Bash')
  })
})

describe('what a press sends', () => {
  it('echoes the row’s own revision, for every verb', () => {
    // **The whole of the optimistic concurrency, from the page's side.** An
    // act that did not carry what the screen said could not be refused for
    // being out of date, and a verb added without it would be the one that
    // undoes somebody's decision at the keyboard.
    for (const verb of SHOWN) {
      const body = bodyFor(verb, ROW, 'abcdefgh12345678', 7, {})
      expect(body.was, verb).toBe(ROW.rev)
      expect(body.task, verb).toBe(ROW.id)
      expect(body.key, verb).toBe('abcdefgh12345678')
      expect(body.rev, verb).toBe(7)
    }
  })

  it('sends a body every verb will actually parse', () => {
    // The two tables meeting: what the page builds, read by the verb that
    // receives it. A field spelled differently on one side is a `malformed`
    // that no test in either package would otherwise catch.
    const typed = {
      allow: true,
      said: 'try the other migration',
      change: 'pause',
      text: 'the fix is in the adapter',
      add: 'the column is nullable',
      summary: 'it runs',
    }
    for (const verb of SHOWN) {
      const body = bodyFor(verb, ROW, 'abcdefgh12345678', 7, typed)
      const found = verbFor(verb)
      expect(found, verb).not.toBeNull()
      expect(found?.read(body).ok, `${verb}: ${JSON.stringify(body)}`).toBe(true)
    }
  })

  it('toggles the park the way the row says it is', () => {
    expect(bodyFor('park', { ...ROW, parked: false }, 'k'.repeat(8), 0, {}).parked).toBe(true)
    expect(bodyFor('park', { ...ROW, parked: true }, 'k'.repeat(8), 0, {}).parked).toBe(false)
  })

  it('names the approval the row is showing, and never just any', () => {
    expect(bodyFor('answer', ROW, 'k'.repeat(8), 0, { allow: false })).toMatchObject({
      approval: 'req-1',
      allow: false,
    })
    // No approval on the row means no id to send: the machine refuses it, and
    // the page never drew the control anyway.
    expect(bodyFor('answer', { ...ROW, approval: null }, 'k'.repeat(8), 0, {}).approval).toBe('')
  })

  it('carries a confirmation that has no shape meaning *do not*', () => {
    for (const verb of ['done', 'intake']) {
      expect(bodyFor(verb, ROW, 'k'.repeat(8), 0, {}).confirm, verb).toBe(true)
    }
  })

  it('never sends an order, a path, a command or a prompt', () => {
    // The shape of every `never remote` line, asked of the page this time: a
    // body the page could build with one of these in it is a body the machine
    // would refuse, and the honest place to find that out is here.
    for (const verb of SHOWN) {
      const body = bodyFor(verb, ROW, 'k'.repeat(8), 0, { order: ['a/b'], path: '/etc', cmd: 'ls' })
      for (const name of ['order', 'path', 'cmd', 'prompt', 'model', 'scopes']) {
        expect(name in body, `${verb} sent ${name}`).toBe(false)
      }
    }
  })

  it('lets somebody type exactly as much as the machine will take', () => {
    // **Four numbers written twice**, so this reads them out of the file the
    // boxes are built in and compares them with the bound the server refuses
    // at. A box that let somebody type more would be a paragraph typed on a
    // phone and then refused whole; one that let them type less would be the
    // page inventing a limit nobody decided. The machine still refuses one
    // past the bound either way: a client bound is a courtesy, never a check.
    const text = readFileSync(new URL('../src/assets/screens.js', import.meta.url), 'utf8')
    const block = /const TYPES = \{([^}]*(?:\}[^}]*)*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block, 'the TYPES block in screens.js').not.toBe('')
    const found = new Map<string, number>()
    for (const one of block.matchAll(/([a-z]+): \{[^}]*?maxlength: '(\d+)'/g)) {
      found.set(one[1] ?? '', Number(one[2]))
    }
    expect([...found.keys()].sort()).toEqual(['context', 'done', 'note', 'steer'])
    expect(found.get('steer')).toBe(BOUNDS.said)
    expect(found.get('note')).toBe(BOUNDS.text)
    expect(found.get('context')).toBe(BOUNDS.add)
    expect(found.get('done')).toBe(BOUNDS.summary)
  })
})

describe('what happens to what somebody typed', () => {
  it('keeps it on every refusal, and clears it only on what happened', () => {
    // **The line somebody would write the other way round.** A `409` is the
    // world having moved; throwing away a paragraph typed on a phone because
    // of it is the one failure they cannot undo.
    expect(afterAnswer({ status: 200, body: { said: 'written down' } }, '')).toEqual({
      ok: true,
      clear: true,
      said: 'written down',
      moved: false,
    })
    for (const error of ERRORS) {
      const came = afterAnswer({ status: 409, body: { error } }, 'something changed')
      expect(came.clear, error).toBe(false)
      expect(came.said, error).toBe('something changed')
    }
  })

  it('says Tade’s own sentence, never an empty one', () => {
    expect(afterAnswer({ status: 200, body: {} }, '').said).toBe('done')
    expect(afterAnswer(null, 'the network went').said).toBe('the network went')
    expect(afterAnswer(undefined, 'the network went').clear).toBe(false)
  })

  it('tells a world that moved apart from a failure, because the page apologises for one', () => {
    expect(afterAnswer({ status: 409, body: { error: 'gone' } }, 'x').moved).toBe(true)
    expect(afterAnswer({ status: 409, body: { error: 'stale' } }, 'x').moved).toBe(true)
    expect(afterAnswer({ status: 500, body: { error: 'broke' } }, 'x').moved).toBe(false)
  })
})

describe('which presses ask again first', () => {
  it('is the two that asking again does not undo, and no others', () => {
    // Marking work finished starts whatever waits on it; approving a
    // stranger's request puts an agent on this machine to work on it. Neither
    // is undone by pressing the same thing twice, so each takes a second tap.
    expect(SHOWN.filter((verb) => confirms(verb))).toEqual(['done', 'intake'])
  })
})

describe('the row the projection actually produces', () => {
  it('carries both lists, so the page always has an answer', () => {
    // Against the real fixture rather than the one above, because the thing
    // that would break this is the projection stopping carrying a field.
    const row = task()
    expect(Array.isArray(row.can)).toBe(true)
    expect(Array.isArray(row.cannot)).toBe(true)
    for (const one of controlsFor(row, BOTH)) {
      expect(['off', 'no', 'yes'], one.verb).toContain(one.kind)
    }
  })
})

// The conversation screen's own rules, as far as they can be asked offline.
//
// **What a browser is the only place for is named rather than claimed.** A tap
// on a real target, a real `Enter` on a focused button, and a `<textarea>`
// still holding its value after a `409` are `scripts/browser.ts`'s, and that
// harness reports `unrun` with a reason on a machine with no browser. What is
// here is the three decisions that are functions: why there is no box, what a
// line says, and what survives a navigation.
describe('the conversation screen', () => {
  it('says why there is no box, and says a different thing for each reason', () => {
    // Three absences and three sentences, because what to do about each is
    // different: turn a setting on, be granted it, or wait. A page that said
    // *you cannot do that* to all three would send somebody to the wrong
    // place twice out of three times.
    expect(reasonFor(null)).toContain('not turned on for this machine')
    expect(reasonFor({ mine: false, busy: false, rev: 'b0', whose: null })).toContain(
      'not granted talking to Tade',
    )
    expect(reasonFor({ mine: true, busy: true, rev: 'b1', whose: 'you' })).toBe(
      'Tade is answering the person at the machine.',
    )
    expect(reasonFor({ mine: true, busy: true, rev: 'b1', whose: 'device aa11' })).toContain(
      'device aa11',
    )
    // And nothing at all where there is a box, so the reason cannot be left
    // over from the last frame.
    expect(reasonFor({ mine: true, busy: false, rev: 'b0', whose: null })).toBe('')
  })

  it('says who said each line, and never says a device was you', () => {
    expect(whoSaid({ from: 'you' })).toBe('you, at the machine')
    expect(whoSaid({ from: 'device aa11' })).toBe('device aa11')
    // Tade's own lines and the model's: the kind's own word already says it.
    for (const from of ['', null, undefined]) expect(whoSaid({ from })).toBe('')
  })

  it('says what a tool line is, where it has no words of its own', () => {
    // A tool carries a name and an outcome and never its arguments, so the row
    // has no words — and a blank one reads as a reply that failed to load.
    expect(saidOn({ kind: 'tool', text: null, outcome: 'running' })).toBe('still going')
    expect(saidOn({ kind: 'tool', text: null, outcome: 'ok' })).toBe('')
    expect(saidOn({ kind: 'reply', text: { words: 'two are working', more: false } })).toBe(
      'two are working',
    )
    // Over the budget, the page says there is more rather than writing three
    // dots into somebody's words.
    expect(saidOn({ kind: 'asked', text: { words: 'half of it', more: true } })).toBe(
      'half of it …',
    )
  })

  it('keeps a half-typed message across a navigation, and lets a send clear it', () => {
    // A navigation is the one moment the page replaces a region, which is
    // right — and losing a half-written message to it is the same failure as a
    // refusal clearing the box.
    const draft = draftStore()
    expect(draft.get()).toBe('')
    draft.set('is the refund flow still red')
    expect(draft.get()).toBe('is the refund flow still red')
    draft.set('')
    expect(draft.get()).toBe('')
    // Anything that is not words is nothing, so a cleared box cannot leave
    // `undefined` where a string is read.
    draft.set(undefined)
    expect(draft.get()).toBe('')
  })
})
