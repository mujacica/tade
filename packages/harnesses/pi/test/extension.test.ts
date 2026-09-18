import { describe, expect, it } from 'vitest'
import { cleanName, firstWords, titleFrom } from '../src/tade.ts'

// What an agent's work is called when nobody named it: the start of the first
// thing it was asked. Tade names the agent's branch from this.

describe('a title from a request', () => {
  it('is the first eight words of its first line', () => {
    expect(
      firstWords('fix the double charge when the webhook retries twice in a row\nand add a test'),
    ).toBe('fix the double charge when the webhook retries')
  })

  it('skips leading blank lines and squeezes spaces', () => {
    expect(firstWords('\n\n   look   at   the logs  ')).toBe('look at the logs')
  })

  it('is never longer than sixty characters', () => {
    expect(firstWords('a'.repeat(200)).length).toBe(60)
  })
})

describe('naming work nobody named', () => {
  it('skips what is not a description of work, and the politeness in front of it', () => {
    expect(
      titleFrom(['Hello, who are you?', 'hi', 'can you fix the double refund on retries please']),
    ).toBe('Fix the double refund on retries')
    expect(titleFrom(["let's add a dark mode toggle to settings"])).toBe(
      'Add a dark mode toggle to',
    )
    expect(titleFrom(['who are you', 'thanks'])).toBeNull()
  })

  it("takes a model's answer as a name: one line, unquoted, a few words", () => {
    expect(cleanName('"Fix double refund on webhook retry."\n\nThis names the work.')).toBe(
      'Fix double refund on webhook retry',
    )
    expect(cleanName('  ')).toBeNull()
  })
})
