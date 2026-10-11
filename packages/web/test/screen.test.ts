import { describe, expect, it } from 'vitest'
import { ELIDED } from '../src/fields.ts'
import { cleanScreen, KNOWN_FLOOR, SCREEN } from '../src/screen.ts'
import { HELD_KEY, PRIVATE, screenText } from './fixtures.ts'

// What of an agent's screen may leave the machine.
//
// Asked against the fixture's own strings rather than against a kind of
// string: a scrubber tested for "no `sk-`" passes on every key that does not
// start with one, and the key `known` exists for looks like nothing at all.

const cleaned = (text = screenText(), known: readonly string[] = [HELD_KEY]) =>
  cleanScreen(text, known)
const joined = (text?: string, known?: readonly string[]) => cleaned(text, known).lines.join('\n')

describe('what is taken off an agent’s screen', () => {
  it('takes out every machine path, the Windows kind included', () => {
    const said = joined()
    expect(said).not.toContain(PRIVATE.root)
    expect(said).not.toContain('testperson')
    expect(said).toContain(`$ cat ${ELIDED}`)
  })

  it('takes out a key Tade holds, by its value, even where it looks like nothing', () => {
    expect(joined()).not.toContain(HELD_KEY)
    // And the same screen with nothing known keeps it: the patterns cannot see
    // a key with no shape, which is the whole reason the window hands its keys
    // over rather than trusting a list of shapes.
    expect(joined(screenText(), [])).toContain('Hq4ZpLw8Rt')
  })

  it('finds a key the terminal wrapped onto two rows, on both of them', () => {
    const rows = cleaned().lines
    // Neither half of it survives, though neither row ever held all of it.
    expect(rows.join('')).not.toContain(HELD_KEY.slice(0, 10))
    expect(rows.join('')).not.toContain(HELD_KEY.slice(10))
    expect(rows.some((row) => row.endsWith(`const KEY = "${ELIDED}`))).toBe(true)
  })

  it('takes out what is shaped like a credential, and keeps the name beside it', () => {
    const said = joined()
    expect(said).not.toContain(PRIVATE.credential)
    // A value that looks like nothing, beside a name that says what it is.
    expect(said).not.toContain(PRIVATE.opaque)
    expect(said).toContain(`ANTHROPIC_API_KEY=${ELIDED}`)
    expect(said).toContain(`GITHUB_TOKEN=${ELIDED}`)
    expect(said).toContain(`Bearer ${ELIDED}`)
  })

  it('takes a private key’s whole block, not only the line that names it', () => {
    const said = joined()
    expect(said).not.toContain('b3BlbnNzaC1')
    expect(said).not.toContain('PRIVATE KEY')
  })

  it('takes a password out of a URL and leaves the rest of it', () => {
    const said = joined('git clone https://amir:Wq8zR2kLm4@example.invalid/acme/app.git')
    expect(said).not.toContain('Wq8zR2kLm4')
    expect(said).toContain(`https://${ELIDED}@example.invalid/acme/app.git`)
  })

  it('takes out every character that reorders or hides what is drawn around it', () => {
    const said = joined()
    const points = [...said].map((one) => one.codePointAt(0) ?? 0)
    const hidden = (at: number) =>
      (at >= 0x202a && at <= 0x202e) ||
      (at >= 0x2066 && at <= 0x2069) ||
      (at >= 0x200b && at <= 0x200f)
    expect(points.filter(hidden)).toEqual([])
    // Controls other than the row breaks themselves.
    expect(points.filter((at) => (at < 0x20 && at !== 0x0a) || at === 0x7f)).toEqual([])
    expect(said).toContain('done evil here')
  })

  it('says how many things it took out, and never what they were', () => {
    const answer = cleaned()
    // The path, the two values after a name, the bearer, the Windows path, the
    // private key's block, and the key across the wrap.
    expect(answer.taken).toBe(7)
    expect(JSON.stringify(answer)).not.toContain('sk-fake')
  })
})

describe('what is left alone', () => {
  it('keeps what the agent was doing, which is what somebody opened the page for', () => {
    const said = joined()
    expect(said).toContain('✻ Reading the adapter')
    expect(said).toContain('4 files touched, the tests pass')
    expect(said).toContain('https://example.invalid')
    // A comment marker is not a path, and a page that took it out would say
    // something was there that was not.
    expect(said).toContain('" // the adapter')
  })

  it('looks for no key shorter than the floor, which would only be taking words out', () => {
    expect(KNOWN_FLOOR).toBeGreaterThanOrEqual(8)
    expect(joined('yes, the tests pass', ['yes'])).toBe('yes, the tests pass')
  })

  it('does not take a usage figure for a credential', () => {
    expect(joined('tokens: 1234 · cost $0.12')).toBe('tokens: 1234 · cost $0.12')
  })

  it('says plainly that a value shaped like nothing, beside nothing, is not found', () => {
    // **The other half of `GRANT_MEANS.lanes`, held.** A key that has no
    // issuer's prefix, sits beside no name and is not one Tade holds is a word
    // like any other. A test that pretended otherwise would be the comfortable
    // half of the sentence.
    expect(joined(`  ${PRIVATE.opaque}`, [])).toBe(`  ${PRIVATE.opaque}`)
  })
})

describe('how much of a screen goes', () => {
  it('sends the newest rows and counts the ones above them, never the scrollback', () => {
    const many = Array.from({ length: 300 }, (_, at) => `row ${at}`).join('\n')
    const answer = cleanScreen(many, [])
    expect(answer.lines).toHaveLength(SCREEN.lines)
    expect(answer.lines.at(-1)).toBe('row 299')
    expect(answer.above).toBe(300 - SCREEN.lines)
  })

  it('cuts a row at the width on whole characters, and counts it', () => {
    const long = '🔧'.repeat(SCREEN.width + 5)
    const answer = cleanScreen(long, [])
    expect([...(answer.lines[0] ?? '')]).toHaveLength(SCREEN.width)
    expect(answer.cut).toBe(1)
  })

  it('drops the empty rows under the last thing drawn', () => {
    expect(cleanScreen('one\ntwo\n\n\n   \n', []).lines).toEqual(['one', 'two'])
  })

  it('still finds a key wrapped from the row above the first one kept', () => {
    // The row the budget cuts off is joined to the first row kept before the
    // cut, so half a key cannot ride in at the top of the screen.
    const wide = 60
    const line = `${'x'.repeat(wide - 10)}${HELD_KEY}`
    const rows = [line.slice(0, wide), line.slice(wide), ...Array(SCREEN.lines - 1).fill('ok')]
    const answer = cleanScreen(rows.join('\n'), [HELD_KEY])
    expect(answer.lines[0]).toBe(ELIDED)
    expect(answer.lines.join('')).not.toContain(HELD_KEY.slice(10))
  })
})
