import { OFFLINE_NEEDS_HTTPS_SHORT } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  installable,
  NOT_SECURE,
  CACHE_PREFIX as PAGE_PREFIX,
  startInstall,
} from '../src/assets/install.js'
import {
  countsOf,
  KEPT,
  onlyKept,
  VIEW_CACHE as PAGE_CACHE,
  VIEW_KEY,
} from '../src/assets/offline.js'
import { applySnapshot, emptyStore } from '../src/assets/store.js'
import { NEVER_A_FIELD } from '../src/fields.ts'
import { CACHE_PREFIX, VIEW_CACHE } from '../src/installable.ts'
import { projector } from '../src/reading.ts'
import { ROUTES, routeFor } from '../src/routes.ts'
import { EVERY, input, NOW, reach } from './fixtures.ts'

// What may end up on a phone's disk.
//
// This is the one place in the away view where the usual answer — *it is
// behind a session, and a session can be revoked* — does not finish the
// sentence. A record written into Cache Storage is on hardware this machine
// cannot reach, and `INSTALLED_IS_NOT_REVOCABLE` is the sentence about what
// that means. So the record is not a redaction of a snapshot, which would be a
// list of what to leave out and one future field away from being wrong: it is
// a **different value**, built by naming what goes in it.
//
// Every test here is some form of *nothing but counts*.

/** A page's store, filled from the real projection for a device granted all. */
function held() {
  const store = emptyStore()
  const made = projector(input({ reach: reach(EVERY) }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

describe('what is kept', () => {
  it('is numbers, all the way down', () => {
    // The strongest form of the claim, and the one that needs no list: there
    // is no string anywhere in the record, so there is no title, no name, no
    // note, no intent, no sentence and no identifier in it either.
    const counts = countsOf(held(), 1_700_000_000_000)
    for (const [name, value] of Object.entries(counts)) {
      expect(typeof value, name).toBe('number')
    }
  })

  it('is exactly the fields that were named, and no others', () => {
    expect(Object.keys(countsOf(held(), 1)).sort()).toEqual([...KEPT].sort())
  })

  it('names nothing a projection may never have', () => {
    // The projection's own list, asked of this record too. It cannot fail
    // today — every field is a count — and it is here because the thing that
    // would change that is somebody adding "just the task name".
    for (const name of KEPT) expect(name in NEVER_A_FIELD, name).toBe(false)
  })

  it('carries the moment it was true, which is what it is drawn with', () => {
    const counts = countsOf(held(), 1_700_000_000_000)
    expect(counts.savedAt).toBe(1_700_000_000_000)
    // The machine's own last word, not this device's clock: the age on the
    // screen is measured against what the machine said, because the phone is
    // somewhere else and its clock is its own.
    expect(counts.at).toBe(NOW)
  })

  it('counts what somebody opens it on a train to know', () => {
    const counts = countsOf(held(), 1)
    expect(counts.tasks).toBeGreaterThan(0)
    expect(counts.projects).toBeGreaterThan(0)
    expect(counts.working).toBeGreaterThanOrEqual(0)
    expect(counts.wantsYou).toBeGreaterThanOrEqual(0)
    expect(counts.working).toBeLessThanOrEqual(counts.tasks)
  })
})

describe('the allow-list is applied to what is read, too', () => {
  it('drops a field somebody else put in the record', () => {
    // A record is a value in a store this origin's pages share, and the
    // version of Tade that wrote one is not always the one reading it. So the
    // way out is filtered as well as the way in.
    const smuggled = onlyKept({ savedAt: 1, tasks: 2, title: 'a task nobody should read' })
    expect(smuggled).not.toBeNull()
    expect(Object.keys(smuggled ?? {}).sort()).toEqual([...KEPT].sort())
    expect(JSON.stringify(smuggled)).not.toContain('nobody should read')
  })

  it('refuses a value of the wrong shape rather than half-reading it', () => {
    expect(onlyKept(null)).toBeNull()
    expect(onlyKept('a string')).toBeNull()
    expect(onlyKept([1, 2, 3])).toBeNull()
    // No moment is no record: an age is the thing that decides whether any of
    // the numbers are worth reading, so a record without one is not one.
    expect(onlyKept({ tasks: 2 })).toBeNull()
    expect(onlyKept({ savedAt: 'yesterday', tasks: 2 })).toBeNull()
  })

  it('turns a field that is not a number into nothing, not into itself', () => {
    const read = onlyKept({ savedAt: 1, tasks: 'lots' })
    expect(read?.tasks).toBeNull()
  })
})

describe('where it is kept', () => {
  it('is named the same thing in the page as in the server’s own file', () => {
    // A browser cannot import a `.ts` file, and the page has to know these
    // names *without asking* — the two moments they matter are a cold open
    // with no answer and a session that has just been refused. So they are
    // spelt twice and held equal here, which is `glyphs.js`'s treatment of the
    // domain's words.
    expect(PAGE_PREFIX).toBe(CACHE_PREFIX)
    expect(PAGE_CACHE).toBe(VIEW_CACHE)
    expect(PAGE_CACHE.startsWith(PAGE_PREFIX)).toBe(true)
  })

  it('tries nothing at all where a browser would refuse it', async () => {
    // **The one branch of the page's install that can be asked offline, and it
    // is the one deciding whether any of the rest happens.** A worker, a cache
    // and an install all need a potentially trustworthy origin, so a page
    // served over plain HTTP on a network must not reach for any of them. The
    // stand-in is a bare `self` with no `isSecureContext` on it, which is what
    // that origin looks like from inside the page.
    const had = Reflect.get(globalThis, 'self')
    Reflect.set(globalThis, 'self', {})
    try {
      expect(installable()).toBe(false)
      let told = 0
      expect(
        await startInstall({ install: true }, () => {
          told += 1
        }),
      ).toBe('insecure')
      expect(told).toBe(0)
    } finally {
      Reflect.set(globalThis, 'self', had)
    }
  })

  it('says why a browser refused it in the domain’s own words', () => {
    // The one failure here nobody is told about by anything else: a browser on
    // a plain address over a network offers none of this and says nothing, so
    // a person who turned the setting on sees a phone where nothing happened.
    // The page says so, in the clause the control at the machine uses, copied
    // because a browser cannot import a `.ts` file.
    expect(NOT_SECURE).toBe(OFFLINE_NEEDS_HTTPS_SHORT)
  })

  it('is under a URL the machine does not serve and the worker cannot answer', () => {
    // Deliberate: a record kept under a path that *is* served would be one a
    // `fetch` could reach, and one a reader could mistake for an answer from
    // the machine. It is read by the page, out of the store, by name.
    expect(routeFor('GET', VIEW_KEY)).toBeNull()
    for (const route of ROUTES) expect(route.path).not.toBe(VIEW_KEY)
  })
})
