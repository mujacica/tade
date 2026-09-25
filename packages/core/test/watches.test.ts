import {
  askAboutWatches,
  ONLY_TELLS,
  STARTS_AGENTS,
  type Step,
  WATCH_REACH,
  type WatchOffered,
  watchesToOffer,
  watchNamedBy,
} from '@tade/core'
import { describe, expect, it } from 'vitest'

// What the first minute offers, and what it says each one costs.
//
// The rule is pure, so it is tested as one: offers in, choices out. What is
// held here is not which watches exist — those change — but the two things
// that made it worth writing. A watch that starts agents is never ticked for
// somebody, however useful it is; and a watch that cannot look says what it
// needs rather than being offered as though it would work.

const watch = (over: Partial<WatchOffered> & Pick<WatchOffered, 'id'>): WatchOffered => ({
  title: 'A watch',
  means: 'looks for something',
  every: '1h',
  offers: 'agent',
  standing: false,
  problem: null,
  ...over,
})

describe('the watches the first minute offers', () => {
  it('ticks one that only tells you, and never one that starts agents', () => {
    const [tells, starts] = watchesToOffer([
      watch({ id: 'review.requested', title: 'Reviews asked of you', offers: 'ask' }),
      watch({ id: 'deps.vulnerabilities', title: 'Vulnerable dependencies' }),
    ])
    expect(tells).toMatchObject({ state: 'offered', ticked: true, costs: ONLY_TELLS })
    // Offered, and never pre-ticked: pressing enter without reading has to
    // mean being told something, never four agents in four lanes by morning.
    expect(starts).toMatchObject({ state: 'offered', ticked: false, costs: STARTS_AGENTS })
  })

  it('says what a watch needs rather than offering one that cannot look', () => {
    const [one] = watchesToOffer([
      watch({ id: 'sentry.new-errors', problem: 'Sentry needs an auth token' }),
    ])
    expect(one).toMatchObject({
      state: 'cannot',
      ticked: false,
      costs: 'Sentry needs an auth token',
    })
  })

  it('says a standing watch is on rather than asking about it', () => {
    // It turns itself on the moment a window opens, so a tick beside it would
    // be a control that changed nothing.
    const [one] = watchesToOffer([watch({ id: 'jev.review', standing: true, offers: 'ask' })])
    expect(one).toMatchObject({ state: 'on', ticked: false })
  })

  it('offers a standing watch whose extension cannot look, because nothing writes it', () => {
    const [one] = watchesToOffer([
      watch({ id: 'jev.review', standing: true, offers: 'ask', problem: 'Jev needs a key' }),
    ])
    expect(one).toMatchObject({ state: 'cannot', costs: 'Jev needs a key' })
  })

  it('leaves alone what is already being watched', () => {
    const [one] = watchesToOffer(
      [watch({ id: 'deps.vulnerabilities' })],
      (id) => id === 'deps.vulnerabilities',
    )
    expect(one?.state).toBe('on')
  })

  it('carries what it is for and how often it looks, which is what is drawn', () => {
    const [one] = watchesToOffer([
      watch({
        id: 'review.branch-checks',
        title: 'Failing CI',
        means: 'reads the commit',
        every: '10m',
      }),
    ])
    expect(one).toMatchObject({ title: 'Failing CI', means: 'reads the commit', every: '10m' })
  })
})

describe('whether the first minute asks about them at all', () => {
  const step = (id: string, done: boolean): Step =>
    ({ id, title: id, done, detail: '', required: false }) as Step

  it('asks where this run is deciding the extensions', () => {
    expect(askAboutWatches([step('model', true), step('extensions', false)])).toBe(true)
  })

  it('and never again once they have been decided', () => {
    // The whole of how it avoids being the step people learn to skip: a
    // question that comes back every time about something you said no to last
    // week is one people press through without reading.
    expect(askAboutWatches([step('model', false), step('extensions', true)])).toBe(false)
    expect(askAboutWatches([step('model', false)])).toBe(false)
    expect(askAboutWatches([])).toBe(false)
  })
})

describe('how far the orchestrator reaches into a watch', () => {
  it('is asked, and says why in words a person is given', () => {
    // Not `never`, where its extension sits: the extension is already on and
    // its code already loaded, so a watch widens nothing an agent may do.
    expect(WATCH_REACH.reach).toBe('asked')
    expect(WATCH_REACH.because.length).toBeGreaterThan(20)
  })

  it('takes the watch named, in either of the spellings people use', () => {
    const one = { id: 'sentry.new-errors', title: 'New Sentry errors' }
    expect(watchNamedBy(one, ['turn on the new errors watch'])).toBe('turn on the new errors watch')
    expect(watchNamedBy(one, ['watch sentry.new-errors please'])).toBeTruthy()
    expect(watchNamedBy(one, ['turn off new-errors'])).toBeTruthy()
  })

  it('does not take the extension’s own name for one of its watches', () => {
    // A section names everything under it: "the sentry watch" identifies none
    // of them where there are four, which is the same reason `wordsFor` drops
    // the first segment of a setting's path.
    const one = { id: 'sentry.new-errors', title: 'New Sentry errors' }
    expect(watchNamedBy(one, ['how is sentry doing'])).toBeNull()
    expect(watchNamedBy(one, ['turn the watches off'])).toBeNull()
  })
})
