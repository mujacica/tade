import { CHECK_STATES } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { type Forge, ForgeError, REVIEW_STATES, type ReviewRef } from './port.ts'

// The shared suite every Forge must pass, written before either
// implementation. It asserts the contract, never the content: what is in
// somebody's pull request is their business.
//
// The two things it will not let through are the ones that would make Tade
// lie about other people's work: a check that is still running reported as
// passed, and a question that cannot be answered coming back as "no" rather
// than as a problem. The third is quieter and just as bad — a write that
// happens when the account can only read.
//
// Nothing here reaches the network or spawns a process: an implementation
// that talks to somebody is given something that answers like them.

export interface ForgeConformanceOptions {
  /** A review the fixture has, for the detail paths. */
  ref: ReviewRef
  /** A ref the fixture does not have, for `missing`. */
  unknown: ReviewRef
  /** A remote it serves, and one it does not. */
  remotes: { serves: string; not: string }
  /** The branch of `ref`, for `reviewOf`, and one with no review at all. */
  branches: { withReview: string; without: string }
  /** A forge with no credential, for the `auth` path. */
  signedOut?(): Forge | Promise<Forge>
  /** A forge that is being rate limited, for the `rate` path. */
  limited?(): Forge | Promise<Forge>
  /** A forge whose account may only read, for the refusal path. */
  readOnly?(): Forge | Promise<Forge>
}

export function testForge(
  name: string,
  make: () => Forge | Promise<Forge>,
  options: ForgeConformanceOptions,
): void {
  describe(`Forge: ${name}`, () => {
    it('declares an id, the words a person reads, and a full capability set', async () => {
      const forge = await make()
      expect(forge.id).toBeTruthy()
      expect(forge.words.one).toBeTruthy()
      expect(forge.words.many).toBeTruthy()
      expect(forge.words.short).toBeTruthy()
      expect(forge.words.number(412)).toContain('412')
      const can = forge.capabilities
      for (const key of [
        'assigned',
        'checks',
        'checkLogs',
        'threads',
        'drafts',
        'rules',
        'mergeQueue',
        'stacks',
        'write',
        'since',
      ] as const) {
        expect(typeof can[key]).toBe('boolean')
      }
      expect(can.costPerPoll).toBeGreaterThan(0)
    })

    it('says which remotes are its own, the same way every time and without asking anybody', async () => {
      const forge = await make()
      const fetch = globalThis.fetch
      globalThis.fetch = (() => {
        throw new Error('serves() must not touch the network')
      }) as typeof globalThis.fetch
      try {
        expect(forge.serves(options.remotes.serves)).toBe(true)
        expect(forge.serves(options.remotes.serves)).toBe(true)
        expect(forge.serves(options.remotes.not)).toBe(false)
      } finally {
        globalThis.fetch = fetch
      }
    })

    it('lists nothing as an empty page, never as a failure', async () => {
      const forge = await make()
      const page = await forge.reviews({ who: 'mine', repos: ['nobody/nothing'] })
      expect(Array.isArray(page.items)).toBe(true)
      expect(page.cursor === null || typeof page.cursor === 'string').toBe(true)
      expect(typeof page.more).toBe('boolean')
    })

    it('never says a review is in a state nothing knows about', async () => {
      const forge = await make()
      const page = await forge.reviews({ who: 'any' })
      for (const review of page.items) {
        expect(REVIEW_STATES).toContain(review.state)
        expect(['none', 'running', 'passed', 'failed']).toContain(review.checks)
        expect(['none', 'approved', 'changes requested', 'review required']).toContain(
          review.decision,
        )
      }
    })

    it('never reports a check that is still going as one that passed', async () => {
      const forge = await make()
      if (!forge.capabilities.checks) return
      const ran = await forge.checks(options.ref)
      for (const run of ran) {
        expect(CHECK_STATES).toContain(run.state)
        expect(run.where.kind).toBe('forge')
        expect(run.commit).toBeTruthy()
      }
      const going = ran.filter((run) => run.state === 'queued' || run.state === 'running')
      for (const run of going) expect(run.state).not.toBe('passed')
    })

    it('reads no more than it was asked for, and says there is more', async () => {
      const forge = await make()
      const page = await forge.reviews({ who: 'any', limit: 1 })
      expect(page.items.length).toBeLessThanOrEqual(1)
      const all = await forge.reviews({ who: 'any' })
      if (all.items.length > 1) expect(page.more).toBe(true)
    })

    it('hands back nothing already seen when a cursor is fed to it again', async () => {
      const forge = await make()
      const first = await forge.reviews({ who: 'any', limit: 1 })
      if (!first.cursor) return
      const next = await forge.reviews({ who: 'any', limit: 1, cursor: first.cursor })
      const seen = new Set(first.items.map((one) => one.url))
      for (const review of next.items) expect(seen.has(review.url)).toBe(false)
    })

    it('says a review it has never heard of is missing, in a sentence', async () => {
      const forge = await make()
      try {
        await forge.review(options.unknown)
        expect.unreachable('an unknown review must be refused')
      } catch (err) {
        expect(err).toBeInstanceOf(ForgeError)
        expect((err as ForgeError).trouble).toBe('missing')
        expect((err as ForgeError).message).toBeTruthy()
      }
    })

    it('answers a branch with no review with nothing at all — this is on every poll', async () => {
      const forge = await make()
      expect(await forge.reviewOf(options.ref.repo, options.branches.without)).toBeNull()
      const found = await forge.reviewOf(options.ref.repo, options.branches.withReview)
      expect(found?.ref.number).toBe(options.ref.number)
    })

    it('refuses what it cannot do, and changes nothing doing it', async () => {
      const forge = await make()
      if (forge.capabilities.checkLogs) return
      await expect(forge.checkLog(options.ref, 'anything', 20)).rejects.toMatchObject({
        trouble: 'unsupported',
      })
      const after = await forge.review(options.ref)
      expect(after.state).toBe((await forge.review(options.ref)).state)
    })

    it('says when it is rate limited, and when to come back', async () => {
      if (!options.limited) return
      const forge = await options.limited()
      const now = Date.now()
      try {
        await forge.reviews({ who: 'mine' })
        expect.unreachable('a rate-limited forge must say so')
      } catch (err) {
        expect((err as ForgeError).trouble).toBe('rate')
        expect((err as ForgeError).retryAt ?? 0).toBeGreaterThan(now)
      }
      const limits = forge.limits()
      if (limits) expect(limits.remaining).toBe(0)
    })

    it('says it is not signed in rather than saying there is nothing there', async () => {
      if (!options.signedOut) return
      const forge = await options.signedOut()
      const who = await forge.whoami()
      expect('problem' in who).toBe(true)
      await expect(forge.reviews({ who: 'mine' })).rejects.toMatchObject({ trouble: 'auth' })
      await expect(forge.review(options.ref)).rejects.toMatchObject({ trouble: 'auth' })
    })

    it('refuses to write with an account that may only read', async () => {
      if (!options.readOnly) return
      const forge = await options.readOnly()
      const who = await forge.whoami()
      if ('problem' in who) return
      expect(who.can).toBe('read')
      await expect(forge.say(options.ref, { body: 'hello' })).rejects.toThrow()
      await expect(forge.mark(options.ref, { ready: true })).rejects.toThrow()
      await expect(forge.merge(options.ref, 'squash')).rejects.toThrow()
    })

    it('says who it is without throwing, whatever the answer', async () => {
      const forge = await make()
      const who = await forge.whoami()
      expect('login' in who ? who.login : who.problem).toBeTruthy()
    })
  })
}
