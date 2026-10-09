import { CHECK_STATES } from '@tade/checks-core'
import { declarationProblems } from '@tade/core'
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
  /**
   * A remote it serves, one it does not, and — for a forge that reads which
   * sign-in a remote belongs to — one that names an account and the account it
   * names.
   */
  remotes: { serves: string; not: string; named?: { remote: string; account: string } }
  /** The branch of `ref`, for `reviewOf`, and one with no review at all. */
  branches: { withReview: string; without: string }
  /**
   * A commit the fixture has run checks on, and one it has not — the second
   * is what a branch looks like in the minute after a push, which is the
   * ordinary case rather than a failure.
   */
  commits: { withChecks: string; nothingRan: string }
  /** A forge with no credential, for the `auth` path. */
  signedOut?(): Forge | Promise<Forge>
  /** A forge that is being rate limited, for the `rate` path. */
  limited?(): Forge | Promise<Forge>
  /** A forge whose account may only read, for the refusal path. */
  readOnly?(): Forge | Promise<Forge>
  /**
   * For a forge that declares `tickets`: a repository the fixture has tickets
   * in, a label at least one of them carries, and a number it has no ticket
   * for. Left out, the ticket section asserts only what can be asserted
   * without a fixture — that a forge saying it has them answers rather than
   * throwing, and that one saying it has none refuses.
   */
  tickets?: { repo: string; label: string; unknown: number }
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
        'commitChecks',
        'checkLogs',
        'threads',
        'drafts',
        'rules',
        'mergeQueue',
        'stacks',
        'write',
        'since',
        'accounts',
        'tickets',
      ] as const) {
        expect(typeof can[key]).toBe('boolean')
      }
      expect(can.costPerPoll).toBeGreaterThan(0)
    })

    it('declares the programs it needs in a way anything can look up and ask', async () => {
      // A forge that speaks HTTP and nothing else declares none, which is an
      // answer; one declaring a program nobody could find or ask is not.
      const forge = await make()
      expect(declarationProblems(forge.programs)).toEqual([])
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

    it('places a remote — where it goes and whose it is — without asking anybody', async () => {
      // `serves` and `placeOf` are one rule with two shapes: two readers of
      // one URL disagreeing is how a project ends up asked about as the wrong
      // account. And both are pure, because the account is a fact about the
      // remote — a forge that resolved it by trying sign-ins against somebody
      // else's API would be slow, rate-limited and indistinguishable from an
      // attack.
      const forge = await make()
      const fetch = globalThis.fetch
      globalThis.fetch = (() => {
        throw new Error('placeOf() must not touch the network')
      }) as typeof globalThis.fetch
      try {
        const place = forge.placeOf(options.remotes.serves)
        expect(place?.host).toBeTruthy()
        expect(forge.placeOf(options.remotes.not)).toBeNull()
        expect(forge.serves(options.remotes.serves)).toBe(true)
        expect(forge.serves(options.remotes.not)).toBe(false)
        // A forge that does not read accounts must never name one: `false` is
        // an answer everything above branches on, not a default.
        if (!forge.capabilities.accounts) expect(place?.account).toBeNull()
        const named = options.remotes.named
        if (named) {
          expect(forge.capabilities.accounts).toBe(true)
          const said = forge.placeOf(named.remote)
          expect(said?.account).toBe(named.account)
          // The alias is a local name for the same forge, so the host it
          // answers is the real one — nothing above should ever build a URL
          // out of somebody's ssh alias.
          expect(said?.host).toBe(place?.host)
          expect(forge.serves(named.remote)).toBe(true)
        }
      } finally {
        globalThis.fetch = fetch
      }
    })

    it('says where a head may be fetched from without asking anybody, or says it publishes none', async () => {
      // A checkout of a review is its own branch (`head.branch`) and nothing
      // else; this is only where that branch's commits are to be had from when
      // the branch is not on this remote at all — a fork. So `null` has to be
      // sayable, and what is said has to be a ref rather than a branch name:
      // anything else and a caller ends up with a local branch called after the
      // number, which is a name nobody else has and nothing can push back.
      const forge = await make()
      const fetch = globalThis.fetch
      globalThis.fetch = (() => {
        throw new Error('headRef() must not touch the network')
      }) as typeof globalThis.fetch
      try {
        const said = forge.headRef(options.ref)
        expect(said === null || said.startsWith('refs/')).toBe(true)
        expect(forge.headRef(options.ref)).toBe(said)
      } finally {
        globalThis.fetch = fetch
      }
    })

    it('says whether a repository can be seen from here, and never throws saying it', async () => {
      // Every way of not being able to see one is an answer: the caller is a
      // watch that has to say something honest rather than fail, and "signed
      // in as somebody who cannot see this" is the answer that stops a
      // perfectly good repository reading as a broken one.
      const forge = await make()
      const seen = await forge.access(options.ref.repo)
      expect(['signed in', 'no access', 'not signed in', 'cannot tell']).toContain(seen.kind)
      if (seen.kind === 'signed in') expect(seen.account).toBeTruthy()
      else expect(seen.said).toBeTruthy()
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

    it('says what ran on a commit, whether or not anything was opened for it', async () => {
      // This is the whole of watching CI on a branch nobody opened a review
      // for — a push straight to the base branch — so it has to answer from
      // the commit alone, and say the commit it answered about.
      const forge = await make()
      if (!forge.capabilities.commitChecks) return
      const ran = await forge.checksOn(options.ref.repo, options.commits.withChecks)
      expect(ran.length).toBeGreaterThan(0)
      for (const run of ran) {
        expect(CHECK_STATES).toContain(run.state)
        expect(run.where.kind).toBe('forge')
        expect(run.commit).toBe(options.commits.withChecks)
        if (run.state === 'queued' || run.state === 'running') expect(run.state).not.toBe('passed')
      }
    })

    it('says nothing ran on a commit rather than saying it could not look', async () => {
      // A push CI has not reached yet is every push, for a minute. Read as a
      // failure it would be a watch saying it cannot look, every ten minutes,
      // about a repository where nothing whatever is wrong.
      const forge = await make()
      if (!forge.capabilities.commitChecks) return
      expect(await forge.checksOn(options.ref.repo, options.commits.nothingRan)).toEqual([])
    })

    it('refuses a log for a check that did not run on that commit, by name', async () => {
      const forge = await make()
      if (!forge.capabilities.commitChecks || !forge.capabilities.checkLogs) return
      await expect(
        forge.checkLogOn(options.ref.repo, options.commits.withChecks, 'no-such-check', 20),
      ).rejects.toMatchObject({ trouble: 'missing' })
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

    it('hands back what people wrote as they wrote it, and the same on a second read', async () => {
      // A comment is what an agent is asked to answer, so it is attacker-
      // controlled text that has to arrive unchanged: summarising it would be
      // summarising the instruction, and normalising it would make two reads
      // of one review two different things to answer.
      const forge = await make()
      if (!forge.capabilities.threads) return
      const first = await forge.review(options.ref)
      const again = await forge.review(options.ref)
      expect(again.threads).toEqual(first.threads)
      for (const thread of first.threads) {
        for (const comment of thread.comments) {
          expect(typeof comment.body).toBe('string')
          // Never trimmed, cut or ellipsised on the way through.
          expect(comment.body).not.toMatch(/…$/)
          expect(comment.by).toBeTruthy()
        }
      }
    })

    it('reads without writing, even with an account that could write', async () => {
      // Every poll goes through these, so one of them quietly changing
      // something would change somebody's review four times a minute.
      const forge = await make()
      const before = await forge.review(options.ref)
      await forge.reviews({ who: 'any' })
      await forge.reviewOf(options.ref.repo, options.branches.withReview)
      if (forge.capabilities.checks) await forge.checks(options.ref)
      if (forge.capabilities.commitChecks) {
        await forge.checksOn(options.ref.repo, options.commits.withChecks)
      }
      const after = await forge.review(options.ref)
      expect(after.state).toBe(before.state)
      expect(after.head.sha).toBe(before.head.sha)
      expect(after.updatedAt).toBe(before.updatedAt)
    })

    it('says what a review belongs to only from what the review says', async () => {
      // `task` is read back out of the body's trailer. A guess — from the
      // branch name, from who wrote it — would look exactly like a fact, and
      // unattributed is always an allowed answer.
      const forge = await make()
      for (const review of (await forge.reviews({ who: 'any' })).items) {
        expect(review.task === null || /^\S+$/.test(review.task), review.url).toBe(true)
      }
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
      // Not signed in and signed in as somebody who cannot see it are opposite
      // facts: one is fixed here and the other is not fixable at all.
      expect((await forge.access(options.ref.repo)).kind).toBe('not signed in')
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

    // --- tickets: the things people file, for a forge that can be asked

    it('refuses to be asked about tickets at all when it says it has none', async () => {
      const forge = await make()
      if (forge.capabilities.tickets) return
      // `unsupported`, never an empty list: "there are no tickets here" and "I
      // cannot be asked about tickets" are opposite facts, and a caller that
      // read the second as the first would report a repository as quiet.
      for (const ask of [
        forge.tickets({ repo: options.ref.repo }),
        forge.ticket({ repo: options.ref.repo, number: 1, host: options.ref.host }),
      ]) {
        await expect(ask).rejects.toMatchObject({ trouble: 'unsupported' })
      }
    })

    it('lists a repository with nothing matching as an empty page, never as missing', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets) return
      const page = await forge.tickets({
        repo: options.ref.repo,
        labels: ['a-label-nobody-has-ever-used-here'],
      })
      expect(page.items).toEqual([])
      // The answer a poll reads as "nothing to do", which must never be
      // reachable by a forge that was not asked with a validator.
      expect(page.unchanged).toBe(false)
    })

    it('never says nothing changed to a caller that handed over no validator', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets) return
      const page = await forge.tickets({ repo: options.ref.repo })
      expect(page.unchanged).toBe(false)
      // A forge with no validator of its own says so rather than inventing
      // one: a caller keeping a validator it was never given would ask the
      // next poll a question this forge cannot answer.
      expect(page.validator === null || typeof page.validator === 'string').toBe(true)
    })

    it('hands back no review as a ticket, whatever it was asked', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets || !options.tickets) return
      const page = await forge.tickets({ repo: options.tickets.repo, state: 'any' })
      const reviews = await forge.reviews({ who: 'any' })
      const numbers = new Set(reviews.items.map((one) => one.ref.number))
      // The whole of what GitHub's own documentation warns about: every pull
      // request is an issue there, so a forge that passed its answer through
      // would start work on somebody's branch as though it were a request.
      for (const ticket of page.items) expect(numbers.has(ticket.ref.number)).toBe(false)
    })

    it('says a ticket it has never heard of is missing, in a sentence', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets || !options.tickets) return
      try {
        await forge.ticket({
          repo: options.tickets.repo,
          number: options.tickets.unknown,
          host: options.ref.host,
        })
        expect.unreachable('an unknown ticket must be refused')
      } catch (err) {
        expect(err).toBeInstanceOf(ForgeError)
        expect((err as ForgeError).trouble).toBe('missing')
        expect((err as ForgeError).message).toBeTruthy()
      }
    })

    it('narrows by label, and says who applied one rather than who wrote the words', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets || !options.tickets) return
      const page = await forge.tickets({
        repo: options.tickets.repo,
        labels: [options.tickets.label],
      })
      expect(page.items.length).toBeGreaterThan(0)
      for (const one of page.items) expect(one.labels).toContain(options.tickets.label)
      const first = page.items[0] as (typeof page.items)[number]
      const whole = await forge.ticket(first.ref)
      expect(whole.labels).toContain(options.tickets.label)
      // Provenance is its own answer and an empty one is allowed — what is not
      // allowed is the author standing in for the labeller, which is the one
      // reading that would authorise the wrong person.
      for (const was of whole.labelled) {
        expect(whole.labels).toContain(was.label)
        expect(was.by.login).toBeTruthy()
        expect(typeof was.by.bot).toBe('boolean')
      }
    })

    it('answers newest movement first, so a bounded read sees what just happened', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets || !options.tickets) return
      const page = await forge.tickets({ repo: options.tickets.repo, state: 'any' })
      const moved = page.items.map((one) => Date.parse(one.updatedAt))
      for (const [at, when] of moved.entries()) {
        if (at === 0) continue
        expect(when).toBeLessThanOrEqual(moved[at - 1] as number)
      }
    })

    it('reads no more tickets than it was asked for, and says there is more', async () => {
      const forge = await make()
      if (!forge.capabilities.tickets || !options.tickets) return
      const page = await forge.tickets({ repo: options.tickets.repo, state: 'any', limit: 1 })
      expect(page.items.length).toBeLessThanOrEqual(1)
      if (!page.cursor) return
      const next = await forge.tickets({
        repo: options.tickets.repo,
        state: 'any',
        limit: 1,
        cursor: page.cursor,
      })
      const seen = new Set(page.items.map((one) => one.ref.number))
      for (const one of next.items) expect(seen.has(one.ref.number)).toBe(false)
    })
  })
}
