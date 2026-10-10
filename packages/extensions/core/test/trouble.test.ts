import { describe, expect, it } from 'vitest'
import { troubleOf, troubleUntil, Unreachable } from '../src/watch.ts'

// Which kind of trouble a look ran into, classified where the error is.
//
// The thing this file is really holding is that **nothing is read out of a
// message**. A sentence containing the words "rate limit" is a sentence about
// a rate limit, not a rate limit — and a look at a repository whose README
// says so would otherwise be classified by its own content, which is a
// stranger deciding what Tade writes in its journal.

/** What a connector's own error looks like: a `trouble` word, and sometimes a reset. */
class Connector extends Error {
  readonly trouble: string
  readonly resetsAt: number
  constructor(trouble: string, resetsAt = 0) {
    super(`the provider said ${trouble}`)
    this.trouble = trouble
    this.resetsAt = resetsAt
  }
}

describe('which kind of trouble a look ran into', () => {
  it('reads nothing coming back as unreachable, by this package’s own type', () => {
    expect(troubleOf(new Unreachable('github.com', 'no answer'))).toBe('unreachable')
  })

  it('reads a connector’s own word, in either spelling of a rate limit', () => {
    // Linear's SDK matches lowercase-with-spaces and its rate-limiting page
    // quotes the uppercase one; Slack says `ratelimited`. All three flatten.
    for (const said of ['ratelimited', 'RATELIMITED', 'rate limited', 'rate-limited']) {
      expect(troubleOf(new Connector(said)), said).toBe('rate-limited')
    }
  })

  it('reads a connector saying nothing came back as unreachable too', () => {
    // `network` is `LinearTrouble`'s word for it, and it means the same thing
    // this package's `Unreachable` does — so it is the same answer rather than
    // a second one that happens to be adjacent.
    expect(troubleOf(new Connector('network'))).toBe('unreachable')
  })

  it('reads a key that is not good and a key that may not see this as refused', () => {
    // Both are *something answered and said no*, which is one thing to do
    // next: go and look at a credential or a grant.
    expect(troubleOf(new Connector('auth'))).toBe('refused')
    expect(troubleOf(new Connector('forbidden'))).toBe('refused')
  })

  it('falls back to HTTP’s own answer where a connector says nothing', () => {
    expect(troubleOf({ status: 429 })).toBe('rate-limited')
    expect(troubleOf({ status: 403 })).toBe('refused')
    expect(troubleOf({ status: 500 })).toBe('refused')
  })

  it('is `other` where nothing says anything at all', () => {
    // The honest answer, and it is not `refused`: an ordinary throw out of a
    // watch's own code says nothing about whether anybody was reached.
    expect(troubleOf(new Error('the radar is down'))).toBe('other')
    expect(troubleOf(null)).toBe('other')
    expect(troubleOf(undefined)).toBe('other')
    expect(troubleOf('a string')).toBe('other')
  })

  it('reads a connector word nothing here knows as refused rather than other', () => {
    // A `trouble` field means the connector reached its provider and got an
    // answer — which is the half that matters — so an unrecognised word is
    // still *something said no*, not *nothing is known*.
    expect(troubleOf(new Connector('linear'))).toBe('refused')
  })

  it('never reads the message, so a ticket cannot classify its own look', () => {
    // The failure this prevents: a repository whose README mentions rate
    // limits, or a ticket somebody wrote the word into, deciding what Tade
    // writes down about its own connector.
    expect(troubleOf(new Error('429 rate limit exceeded, unreachable, forbidden'))).toBe('other')
  })
})

describe('when a spent budget is clear again', () => {
  it('is the moment the source itself gave', () => {
    const at = Date.parse('2026-10-09T11:00:00Z')
    expect(troubleUntil(new Connector('ratelimited', at))).toBe(at)
  })

  it('is nought where nobody said, which is the spelling the journal already has', () => {
    // `0` and not null, because that is what `watchChecked` writes and what
    // `watchedFrom` already reads as *nobody said*. A second spelling of
    // nothing is a client written against one of them getting it wrong.
    expect(troubleUntil(new Connector('ratelimited'))).toBe(0)
    expect(troubleUntil(new Error('x'))).toBe(0)
    expect(troubleUntil({ resetsAt: 'soon' })).toBe(0)
    expect(troubleUntil({ resetsAt: Number.NaN })).toBe(0)
    expect(troubleUntil(null)).toBe(0)
  })
})
