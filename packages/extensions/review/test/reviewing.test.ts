import { ACTING_IS_NOT_YOU, settingReach } from '@tade/core'
import type { FilePatch, Patch, ReviewRef } from '@tade/forges-core'
import { describe, expect, it } from 'vitest'
import type { Found } from '../src/record.ts'
import { grantedNow } from '../src/reviewer.ts'
import {
  ACT_SETTINGS,
  anchored,
  anchorsIn,
  FINDING_KINDS,
  type Finding,
  findingFrom,
  findingId,
  fixKey,
  grantProblem,
  grantProblems,
  keyIsAbout,
  markedBy,
  marker,
  mayI,
  NO_GRANTS,
  oursAlready,
  RUBRIC_VERSION,
  reviewerOf,
  reviewKey,
  reviewVersion,
  whyNotFix,
  whyNotReview,
  wouldLeak,
} from '../src/reviewing.ts'

// The policy, with nothing plugged into it: a grant, an anchor, a redaction
// and a bound are all pure questions, and every one of them is the answer that
// decides whether Tade writes in somebody else's repository.

const ref: ReviewRef = { host: 'github.com', repo: 'acme/api', number: 412 }
const NOW = Date.parse('2026-09-19T08:00:00Z')

const grants = (each: Partial<Record<'review' | 'comment' | 'fix' | 'push', string[]>>) => ({
  ...NO_GRANTS,
  ...each,
})

describe('a grant', () => {
  it('is nobody until somebody writes one, for every act separately', () => {
    for (const act of ['review', 'comment', 'fix', 'push'] as const) {
      const answer = mayI(act, NO_GRANTS, ref)
      expect(answer.yes).toBe(false)
      // The refusal names the key to write in, because a grant nobody can work
      // out how to write is a feature nobody turns on.
      expect(answer.yes === false && answer.because).toContain(`extensions.review.${act}_in`)
    }
  })

  it('does not let one act stand in for another', () => {
    // Reading a change, posting about it, starting work on it and pushing that
    // work are four things, and the whole point is that wanting the first is
    // not wanting the fourth.
    const only = grants({ review: ['github.com/acme/api'] })
    expect(mayI('review', only, ref).yes).toBe(true)
    expect(mayI('comment', only, ref).yes).toBe(false)
    expect(mayI('fix', only, ref).yes).toBe(false)
    expect(mayI('push', only, ref).yes).toBe(false)
  })

  it('matches the host as well as the repository', () => {
    const elsewhere = grants({ review: ['gitlab.acme.test/acme/api'] })
    // The same `acme/api`, on a forge the grant did not name.
    expect(mayI('review', elsewhere, ref).yes).toBe(false)
    expect(mayI('review', elsewhere, { ...ref, host: 'gitlab.acme.test' }).yes).toBe(true)
  })

  it('is one repository, and a pattern is not a grant at all', () => {
    // `acme/*` is the same shape as "anybody", over repositories nobody has
    // looked at — and no forge can be asked for one either, so a glob would
    // match here and find nothing there.
    expect(grantProblem('github.com/acme/*')).toContain('a grant is one repository')
    expect(grantProblem('*/acme/api')).toContain('a grant is one repository')
    expect(grantProblem('github.com/acme/ap?')).toContain('a grant is one repository')
    expect(mayI('review', grants({ review: ['github.com/acme/*'] }), ref).yes).toBe(false)
    expect(mayI('review', grants({ review: ['github.com/acme/ap'] }), ref).yes).toBe(false)
    expect(grantProblem('github.com/acme/api')).toBeNull()
  })

  it('matches a forge’s own names case-insensitively', () => {
    // Or `github.com/Acme/API` is a line somebody wrote that never matches.
    expect(mayI('review', grants({ review: ['github.com/Acme/API'] }), ref).yes).toBe(true)
  })

  it('refuses a line with no host as a configuration mistake, not as a match', () => {
    // Two forges can both have `acme/api`, so a hostless line is not a grant —
    // and it is *named*, because silently matching nothing is the worst of both.
    expect(grantProblem('acme/api')).toContain('host-first')
    const bad = grants({ comment: ['acme/api', 'github.com/acme/other'] })
    expect(mayI('comment', bad, ref).yes).toBe(false)
    expect(grantProblems(bad).map((one) => one.entry)).toEqual(['acme/api'])
    expect(grantProblems(grants({ comment: ['github.com/acme/api'] }))).toEqual([])
  })

  it('answers no when the host could not be read at all', () => {
    expect(
      mayI('review', grants({ review: ['github.com/acme/api'] }), { ...ref, host: '' }).yes,
    ).toBe(false)
  })

  it('says which line allowed it, so a refusal and an allowance read the same way', () => {
    const answer = mayI('fix', grants({ fix: [' github.com/acme/api '] }), ref)
    expect(answer).toEqual({ yes: true, by: 'github.com/acme/api' })
  })
})

describe('which change a review is of', () => {
  it('is the repository, the number, the head and the rubric', () => {
    const version = reviewVersion(ref, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(version).toBe(`github.com/acme/api#412@a1b2c3d4e5f6:${RUBRIC_VERSION}`)
    // A push makes a new review of the same pull request; a re-run does not.
    expect(reviewVersion(ref, 'ffffffffffffffff')).not.toBe(version)
  })

  it('reads its own keys back, and nobody else’s', () => {
    const key = reviewKey(ref, 'a1b2c3d4e5f6ffff')
    expect(keyIsAbout(key)).toEqual({ ref, what: 'review', head: 'a1b2c3d4e5f6' })
    expect(keyIsAbout(fixKey(ref, 'a1b2c3d4e5f6ffff'))?.what).toBe('review-fix')
    expect(keyIsAbout('github.com/acme/api#412:thread:PRRT_1:PRRC_2')).toBeNull()
    expect(keyIsAbout('github.com/acme/api@deadbeef')).toBeNull()
  })

  it('is one fix key per head, so one review drives one fix however many findings', () => {
    expect(fixKey(ref, 'aaaaaaaaaaaaaaa')).toBe(fixKey(ref, 'aaaaaaaaaaaaaaa'))
    expect(fixKey(ref, 'aaaaaaaaaaaaaaa')).not.toBe(fixKey(ref, 'bbbbbbbbbbbbbbb'))
  })
})

describe('the marker', () => {
  it('is how Tade knows its own words, and is invisible where markdown is rendered', () => {
    const body = `something it found\n${marker('github.com/acme/api#412@aaa:r1/deadbeef00')}`
    expect(body).toContain('<!--')
    expect(markedBy(body)).toBe('github.com/acme/api#412@aaa:r1/deadbeef00')
    expect(oursAlready(body)).toBe(true)
    expect(oursAlready('a bot wrote this and it mentions tade-review in passing')).toBe(false)
  })

  it('names one finding the same way every time, out of the words of it', () => {
    const one: Finding = {
      kind: 'defect',
      path: 'src/a.ts',
      line: 4,
      what: 'the key is dropped',
      why: 'two refunds go out',
    }
    expect(findingId(one)).toBe(findingId({ ...one, why: 'reworded entirely' }))
    expect(findingId(one)).not.toBe(findingId({ ...one, what: 'something else' }))
  })
})

describe('what a reviewer may report', () => {
  it('has no kind for anything cosmetic, so an automated review cannot post one', () => {
    expect(FINDING_KINDS).not.toContain('nit')
    expect(FINDING_KINDS).not.toContain('style')
    const read = findingFrom({ kind: 'nit', path: 'a.ts', what: 'rename this', why: 'clarity' })
    expect('problem' in read && read.problem).toContain('defect, missing test, risk, question')
  })

  it('refuses a finding whose consequence nobody stated', () => {
    const read = findingFrom({ kind: 'risk', path: 'a.ts', line: 3, what: 'this looks odd' })
    expect('problem' in read && read.problem).toContain('what would go wrong')
  })

  it('refuses one with no file, and takes a line only where there is one', () => {
    expect('problem' in findingFrom({ kind: 'defect', what: 'x', why: 'y' })).toBe(true)
    const read = findingFrom({ kind: 'defect', path: 'a.ts', what: 'x', why: 'y' })
    expect('finding' in read && read.finding.line).toBeNull()
    const numbered = findingFrom({ kind: 'defect', path: 'a.ts', line: '12', what: 'x', why: 'y' })
    expect('finding' in numbered && numbered.finding.line).toBe(12)
  })
})

describe('anchors', () => {
  const file: FilePatch = {
    path: 'src/refunds.ts',
    from: null,
    added: 5,
    removed: 1,
    what: 'changed',
    patch: [
      '@@ -38,7 +38,12 @@ export async function refund(charge: Charge) {',
      '   const key = idempotencyKey(charge)',
      '-  return gateway.refund(charge, key)',
      '+  try {',
      '+    return await gateway.refund(charge, key)',
      '+  } catch {',
      '+    return await gateway.refund(charge)',
      '+  }',
      ' }',
    ].join('\n'),
  }
  const binary: FilePatch = {
    path: 'docs/logo.png',
    from: null,
    added: 0,
    removed: 0,
    what: 'changed',
    patch: null,
  }
  const patch: Patch = { head: 'aaaa', base: 'bbbb', files: [file, binary], more: false }

  it('is the new side of the hunk and nothing else', () => {
    const lines = anchorsIn(file)
    expect([...lines].sort((a, b) => a - b)).toEqual([38, 39, 40, 41, 42, 43, 44])
    // A removed line is on the old side and is not a place on this one.
    expect(lines.has(45)).toBe(false)
  })

  it('has none at all for a file the forge handed no patch over for', () => {
    // Which is why a binary file gets a note about the file and never a line:
    // "no patch" and "an empty patch" are opposite facts.
    expect(anchorsIn(binary).size).toBe(0)
  })

  it('puts a note on its line, on its file, or says it is adrift — never nowhere', () => {
    const findings: Finding[] = [
      { kind: 'defect', path: 'src/refunds.ts', line: 40, what: 'a', why: 'b' },
      { kind: 'risk', path: 'src/refunds.ts', line: 900, what: 'c', why: 'd' },
      { kind: 'defect', path: 'docs/logo.png', line: 2, what: 'e', why: 'f' },
      { kind: 'question', path: 'src/never-touched.ts', line: 1, what: 'g', why: 'h' },
    ]
    const placed = anchored(findings, patch, (one) => one.what)
    expect(placed.notes.map((one) => [one.path, one.line])).toEqual([
      ['src/refunds.ts', 40],
      // A line this diff does not have becomes a note about the file, never a
      // comment against code the reviewer never read.
      ['src/refunds.ts', null],
      ['docs/logo.png', null],
    ])
    expect(placed.adrift.map((one) => one.finding.path)).toEqual(['src/never-touched.ts'])
    expect(placed.adrift[0]?.because).toContain('not one of the files this change touches')
  })
})

describe('what may never leave this machine', () => {
  const where = { home: '/Users/somebody/.tade', roots: ['/Users/somebody/src/api'] }

  it('refuses rather than rewriting, and says which half of the rule it is', () => {
    expect(wouldLeak('the test at /Users/somebody/src/api/src/a.test.ts fails', where)).toContain(
      'a path on this machine',
    )
    expect(wouldLeak('set GITHUB_TOKEN=ghp_01234567890123456789 and retry', where)).toContain(
      'credential',
    )
    expect(wouldLeak('open file:///etc/hosts', where)).toContain('file:// url')
  })

  it('catches somebody else’s home as well as this one', () => {
    // A reviewer that pasted a colleague's path has leaked a colleague.
    expect(wouldLeak('see /Users/kim/work/notes.md', where)).toContain('home directory')
    expect(wouldLeak('see /home/kim/work/notes.md', where)).toContain('home directory')
  })

  it('lets an ordinary finding through, written as the repository has it', () => {
    expect(
      wouldLeak(
        '`src/refunds.ts` retries without a backoff, so a dead gateway is hit twice',
        where,
      ),
    ).toBeNull()
  })
})

describe('the bounds on the loop', () => {
  const made = (key: string, at: string, task: string | null): Found => ({
    at,
    key,
    title: 'something',
    task,
    told: false,
    problem: null,
  })
  const bounds = { rounds: 2, cooldownMs: 30 * 60_000, notes: 20 }

  it('lets a change nothing has reviewed through', () => {
    expect(whyNotReview([], ref, 'aaaa', NOW, bounds)).toBeNull()
  })

  it('holds inside the cooldown, so a push and a review cannot chase each other', () => {
    const record = [made(reviewKey(ref, 'aaaa'), '2026-09-19T07:50:00Z', 'tade/review-412')]
    expect(whyNotReview(record, ref, 'bbbb', NOW, bounds)).toContain('cooldown')
    // And lets it through once the cooldown has passed.
    expect(whyNotReview(record, ref, 'bbbb', NOW + 60 * 60_000, bounds)).toBeNull()
  })

  it('stops at the round cap and says somebody should look at it', () => {
    const record = [
      made(reviewKey(ref, 'aaaa'), '2026-09-19T02:00:00Z', 'tade/review-1'),
      made(reviewKey(ref, 'bbbb'), '2026-09-19T03:00:00Z', 'tade/review-2'),
    ]
    expect(whyNotReview(record, ref, 'cccc', NOW, bounds)).toContain('somebody should look at it')
    // Counted over a window, so a bad afternoon does not stop it forever.
    expect(whyNotReview(record, ref, 'cccc', NOW + 48 * 3_600_000, bounds)).toBeNull()
  })

  it('does not count a finding nothing was started on', () => {
    // A finding that could not start an agent is not a round of the loop.
    const record = [
      made(reviewKey(ref, 'aaaa'), '2026-09-19T02:00:00Z', null),
      made(reviewKey(ref, 'bbbb'), '2026-09-19T03:00:00Z', null),
    ]
    expect(whyNotReview(record, ref, 'cccc', NOW, bounds)).toBeNull()
  })

  it('is one active fix per pull request, whatever head it was started on', () => {
    const record = [made(fixKey(ref, 'aaaa'), '2026-09-19T07:55:00Z', 'tade/fix-412')]
    expect(whyNotFix(record, ref, NOW, bounds)).toContain('one fix at a time')
    // And a review waits while that fix runs, rather than reviewing over it.
    expect(whyNotReview(record, ref, 'bbbb', NOW, bounds)).toContain('already fixing')
  })

  it('stops starting fixes at the round cap', () => {
    const record = [
      made(fixKey(ref, 'aaaa'), '2026-09-19T01:00:00Z', 'tade/fix-1'),
      made(fixKey(ref, 'bbbb'), '2026-09-19T02:00:00Z', 'tade/fix-2'),
    ]
    expect(whyNotFix(record, ref, NOW, bounds)).toContain('somebody should look at it')
  })

  it('is about one review and never about the one next to it', () => {
    const other = { ...ref, number: 418 }
    const record = [made(fixKey(other, 'aaaa'), '2026-09-19T07:55:00Z', 'tade/fix-418')]
    expect(whyNotFix(record, ref, NOW, bounds)).toBeNull()
  })
})

describe('who may publish a review', () => {
  const made = (key: string, task: string | null): Found => ({
    at: '2026-09-19T07:00:00Z',
    key,
    title: 'review it',
    task,
    told: false,
    problem: null,
  })

  it('is the task Tade started on that exact change, out of the journal', () => {
    const record = [made(reviewKey(ref, 'a1b2c3d4e5f6ffff'), 'tade/review-412')]
    expect(reviewerOf(record, ref, 'a1b2c3d4e5f6ffff')).toBe('tade/review-412')
    // A different head is a different review, and its reviewer is nobody yet.
    expect(reviewerOf(record, ref, 'ffffffffffffffff')).toBeNull()
    expect(reviewerOf(record, { ...ref, number: 418 }, 'a1b2c3d4e5f6ffff')).toBeNull()
  })

  it('is nobody where the finding started nothing', () => {
    expect(reviewerOf([made(reviewKey(ref, 'aaaaaaaaaaaa'), null)], ref, 'aaaaaaaaaaaa')).toBeNull()
  })
})

describe('how far anything but a person reaches into a grant', () => {
  it('is refused to the orchestrator, by the subtree every extension key is in', () => {
    // Not a property of these keys, which is the point: a grant added next
    // month by somebody who never read `reach.ts` is refused on the day it is
    // written, because `extensions` is a `never` *subtree*.
    for (const act of ['review', 'comment', 'fix', 'push'] as const) {
      const reach = settingReach(`extensions.review.${ACT_SETTINGS[act].key}`)
      expect(reach.reach).toBe('never')
      expect(reach.because).toBeTruthy()
    }
    for (const bound of ['rounds', 'cooldown', 'notes']) {
      expect(settingReach(`extensions.review.${bound}`).reach).toBe('never')
    }
  })

  it('is unreachable from a paired device, which can never change a setting at all', () => {
    // The away view has no route to a setting, so a grant is not something a
    // phone can be talked into writing either.
    expect(ACTING_IS_NOT_YOU).toContain('never change a setting')
  })
})

describe('what somebody setting this up is told', () => {
  it('says plainly that nothing is granted, rather than leaving four empty lists to read', () => {
    // "off" and "on for one repository" look identical in a config file you
    // are scrolling, and the whole claim here is that it is off until it is not.
    expect(grantedNow(NO_GRANTS)).toContain('Nothing is granted')
    const some = grantedNow({ ...NO_GRANTS, review: ['github.com/acme/api'] })
    expect(some).toContain('review_in github.com/acme/api')
    expect(some).not.toContain('comment_in')
  })

  it('says when a line somebody wrote is not a grant and matches nothing', () => {
    expect(grantedNow({ ...NO_GRANTS, comment: ['acme/api'] })).toContain('is not a grant')
  })
})

describe('reviewing one commit twice', () => {
  it('is refused on the head itself, not only on the key the watch remembers', () => {
    // A watch turned off and on again forgets its keys; the journal does not.
    const record: Found[] = [
      {
        at: '2026-09-19T02:00:00Z',
        key: reviewKey(ref, 'a1b2c3d4e5f6'),
        title: 'review it',
        task: 'api/review-412',
        told: false,
        problem: null,
      },
    ]
    expect(whyNotReview(record, ref, 'a1b2c3d4e5f6ffff', NOW)).toContain('already reviewed it at')
    expect(whyNotReview(record, ref, 'ffffffffffff', NOW)).toBeNull()
  })
})
