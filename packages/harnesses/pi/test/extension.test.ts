import { describe, expect, it } from 'vitest'
import { firstWords } from '../src/extension.ts'

// What an agent's work is called when nobody named it: the start of the first
// thing it was asked. Wilco names the agent's branch from this.

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
