import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICONS } from '../src/assets/icons.js'
import { partsOf } from '../src/assets/live.js'
import { deviceWord, FLOWS, formOf, STEP_COUNT, stepOf } from '../src/assets/pair.js'
import { quickWord } from '../src/assets/quick.js'
import { barsFor, ENDING_WARNS_MS, endingBar } from '../src/assets/shell.js'
import { emptyStore } from '../src/assets/store.js'
import { reasonFor, reasonWord } from '../src/assets/talk.js'
import { assetsDir } from '../src/assets.ts'
import { scripts } from './asset-files.ts'

// The presses on a card, the composer's absences, the icons, pairing and the
// session's end — the parts of the page that are rules rather than drawing,
// held here with no browser.
//
// **What this cannot see is how any of it looks**, which is the browser
// harness's (`scripts/browser.ts`) and in the end the owner's. What it can see
// is that every icon the page asks for is one the shell actually drew, and
// that each word a press or an absence says is the one it means. The
// overview's figures are `overview.test.ts`'s.

const DIR = assetsDir()

describe('the presses on a card', () => {
  it('say what they do in a word, and the tool an approval is for', () => {
    expect(quickWord('answer', { approval: { tool: 'Bash' } })).toBe('Allow Bash')
    expect(quickWord('park', { parked: false })).toBe('Set aside')
    expect(quickWord('park', { parked: true })).toBe('Resume')
    expect(quickWord('done', {}, true)).toBe('Sure?')
  })
})

describe('an absence, in a word', () => {
  it('has a word for each of the three, and the sentence is still there behind it', () => {
    const off = null
    const ungranted = { mine: false, busy: false }
    const busy = { mine: true, busy: true, whose: 'you' }
    const words = [off, ungranted, busy].map(reasonWord)
    expect(new Set(words).size).toBe(3)
    for (const talk of [off, ungranted, busy]) expect(reasonFor(talk)).not.toBe('')
    expect(reasonWord({ mine: true, busy: false })).toBe('')
    expect(reasonWord(undefined)).toBe('')
  })
})

describe('the icons', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8')
  const drawn = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((one) => one[1]))

  it('are every one drawn in the shell’s sprite, and none drawn that is not named', () => {
    expect([...drawn].sort()).toEqual([...ICONS].sort())
  })

  it('are only ever asked for by a name the sprite has', () => {
    // A name nobody drew is a blank square where an icon should be, and no
    // test that does not look for it would see one.
    for (const name of scripts(DIR)) {
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const found of text.matchAll(/\bicon\('([\w-]+)'/g)) {
        expect(drawn.has(found[1] ?? ''), `${name} asks for ${found[1]}`).toBe(true)
      }
    }
  })
})

describe('the very first ask', () => {
  it('is connecting, with no bar: nothing was read, so nothing is behind', () => {
    const connection = { kind: 'unreachable' as const, sinceAt: 0 }
    expect(partsOf('connecting', connection, '—', 0).words).toBe('connecting')
    expect(barsFor('connecting', connection, emptyStore(), 0, 0)).toEqual([])
    // And a drop after that is reconnecting, with its bar, as before.
    expect(barsFor('reconnecting', connection, emptyStore(), 0, 0)).toHaveLength(1)
  })
})

describe('pairing, as four steps', () => {
  it('starts at the start with no code, at naming with one, and waits at the machine', () => {
    expect(stepOf(false, 'idle')).toBe(0)
    expect(stepOf(true, 'idle')).toBe(2)
    expect(stepOf(true, 'asking')).toBe(3)
    expect(stepOf(true, 'done')).toBe(STEP_COUNT)
    // A refusal burned the code: the way on is a new one, from scanning.
    expect(stepOf(true, 'refused')).toBe(1)
  })

  it('leads a phone to scan the code and a computer to open its link', () => {
    for (const flow of Object.values(FLOWS)) expect(flow).toHaveLength(STEP_COUNT)
    expect(FLOWS.handheld.map((step) => step.key)).toEqual(['open', 'scan', 'name', 'approve'])
    expect(FLOWS.computer.map((step) => step.key)).toEqual(['open', 'link', 'name', 'approve'])
    // A computer has no camera step to tell it about.
    expect(FLOWS.computer.some((step) => /scan|camera/i.test(`${step.title} ${step.sub}`))).toBe(
      false,
    )
  })

  it('tells a phone from a computer by the browser and the finger', () => {
    expect(formOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile', false)).toBe(
      'handheld',
    )
    expect(formOf('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', false)).toBe('handheld')
    expect(formOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false)).toBe('computer')
    // An iPad asking for the desktop site says Mac; its pointer is a finger.
    expect(formOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true)).toBe('handheld')
    expect(formOf(undefined, undefined)).toBe('computer')
  })

  it('offers what the device is as its name, and nothing more particular', () => {
    expect(deviceWord('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
    expect(deviceWord('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile')).toBe('Android phone')
    expect(deviceWord('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac')
    expect(deviceWord('')).toBe('')
  })
})

describe('a session about to run out', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z')
  const at = (ms: number) => new Date(now + ms).toISOString()

  it('says so three days ahead, with the time left, and not before', () => {
    expect(endingBar(at(ENDING_WARNS_MS + 60_000), now)).toBeNull()
    expect(endingBar(at(2 * 3_600_000), now)?.lead).toBe('Signs out in 2h 0m')
  })

  it('says nothing once it has ended, or for a session it cannot read', () => {
    expect(endingBar(at(-1), now)).toBeNull()
    expect(endingBar(undefined, now)).toBeNull()
    expect(endingBar('not a moment', now)).toBeNull()
  })
})
