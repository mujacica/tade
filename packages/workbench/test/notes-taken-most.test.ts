import { appendFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Memory, NOTES_FULL, NOTES_TAKEN_MOST } from '../src/memory.ts'

// What other machines give the notes file has a ceiling: any agent on a
// linked machine can append to its own, and it is given here a round at a
// time. What is noted here is never refused.

const NOW = Date.parse('2026-11-23T09:00:00Z')

describe('the notes another machine gives', () => {
  it('are refused, and said, once the file is past its ceiling — and a note made here never is', () => {
    const one = Memory.open(tmp('tade-notes-most-'))
    one.remember('refunds go through the ledger', 'app', 'cli', NOW)
    const far = Memory.open(tmp('tade-notes-far-'))
    far.remember('a note the box wrote', 'app', 'cli', NOW + 1)
    const given = far.shared().map((line) => ({ line: line.line }))
    // Filled to just under the ceiling, as a stream of rounds from there would leave it.
    appendFileSync(one.path, `${'x'.repeat(NOTES_TAKEN_MOST - statSync(one.path).size - 10)}\n`)
    expect(() => one.take(given, 'box', NOW + 2)).toThrow(NOTES_FULL)
    expect(one.all().map((note) => note.text)).not.toContain('a note the box wrote')
    // The person's own word still goes down.
    one.remember('the queue waits for the migration', 'app', 'cli', NOW + 3)
    expect(one.all().map((note) => note.text)).toContain('the queue waits for the migration')
  })

  it('are taken as ever below it', () => {
    const one = Memory.open(tmp('tade-notes-room-'))
    const far = Memory.open(tmp('tade-notes-far-'))
    far.remember('a note the box wrote', 'app', 'cli', NOW)
    const took = one.take(
      far.shared().map((line) => ({ line: line.line })),
      'box',
      NOW + 1,
    )
    expect(took.notes).toBe(1)
  })
})
