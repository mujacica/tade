import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentOf } from '../src/agent.ts'
import { mayFor, WITHHOLDS as PAGE, grantOf as pageGrantOf } from '../src/assets/access.js'
import { settingsFor } from '../src/configuring.ts'
import { GRANTS, type Grant, grantOf, WITHHOLDS } from '../src/reach.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { scripts } from './asset-files.ts'
import { agentHeld, EVERY, input, NOW, reach } from './fixtures.ts'

// **One table, and a page can never disagree with the machine.** `WITHHOLDS`
// says where each grant is enforced; this file holds it to the projection's
// real gates in both directions, holds the page's copy equal to it, and holds
// every page to asking through it rather than naming a grant of its own — the
// shape of the bug where a page said *not granted* about reviews whose state
// the machine had sent, and the overview's quotas sat behind a grant nobody
// could tell they were behind.

/** Every place two snapshots differ, with array positions folded away. */
function differ(a: unknown, b: unknown, path: string, out: Set<string>): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return
  if (Array.isArray(a) && Array.isArray(b)) {
    // A collection that lost rows was withheld whole, which is the bare name.
    if (a.length !== b.length) {
      out.add(path)
      return
    }
    for (let at = 0; at < a.length; at++) differ(a[at], b[at], path, out)
    return
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      differ(left[key], right[key], path === '' ? key : `${path}.${key}`, out)
    }
    return
  }
  out.add(path)
}

/** What a device with every grant but one is not sent, as places on the wire. */
function withheldWithout(grant: Grant): string[] {
  const all = snapshotOf(input({ reach: reach(EVERY) }), NOW)
  const less = snapshotOf(input({ reach: reach(EVERY.filter((one) => one !== grant)) }), NOW)
  const out = new Set<string>()
  // `you` says what was granted and `pages` counts what was left out: both
  // differ by construction, and neither is content.
  differ({ ...all, you: null, pages: null }, { ...less, you: null, pages: null }, '', out)
  return [...out].sort()
}

/** The answers that are not part of the snapshot: their gates are held in their own tests. */
const ANSWERS = [
  'agent.screen',
  'settings',
  'evaluations.cost',
  'evaluations.findings',
  'evaluations.races.said',
  'evaluations.races.usd',
  'evaluations.races.order',
]

describe('what each grant withholds', () => {
  it('is exactly where the projection gates it, for every grant', () => {
    for (const grant of GRANTS) {
      const listed = WITHHOLDS[grant].filter((path) => !ANSWERS.includes(path))
      expect(withheldWithout(grant), grant).toEqual([...listed].sort())
    }
  })

  it('names each place once, so a place has one grant', () => {
    const every = GRANTS.flatMap((grant) => WITHHOLDS[grant])
    expect(new Set(every).size).toBe(every.length)
    for (const grant of GRANTS)
      for (const path of WITHHOLDS[grant]) expect(grantOf(path)).toBe(grant)
    expect(grantOf('tasks.state')).toBeNull()
  })

  it('withholds the two answers of their own under their own grant', () => {
    const tasks = input().tasks
    const task = tasks[0]?.id ?? ''
    expect(grantOf('agent.screen')).toBe('lanes')
    expect(
      agentOf(reach(EVERY.filter((one) => one !== 'lanes')), tasks, task, agentHeld()).why,
    ).toBe('not granted')
    expect(agentOf(reach(['lanes']), tasks, task, agentHeld()).why).toBeNull()
    expect(grantOf('settings')).toBe('settings')
    expect(settingsFor([], reach(EVERY.filter((one) => one !== 'settings'))).granted).toBe(false)
    expect(settingsFor([], reach(['settings'])).granted).toBe(true)
    // The scorecards: money under `spend`, and the judge under `findings`
    // (`test/evaluations.test.ts` holds each cell of it).
    expect(grantOf('evaluations.cost')).toBe('spend')
    expect(grantOf('evaluations.findings')).toBe('findings')
    // The races: what was asked under `intent`, the money under `spend`, and
    // the order the judge's part puts them in under `findings`.
    expect(grantOf('evaluations.races.said')).toBe('intent')
    expect(grantOf('evaluations.races.usd')).toBe('spend')
    expect(grantOf('evaluations.races.order')).toBe('findings')
  })

  it('quotas are what a sign-in used of its plan, sent with the money and nothing less', () => {
    // The overview's quotas: `plans`, under `spend`, the account's name under `accounts`.
    const with_ = snapshotOf(input({ reach: reach(['spend']) }), NOW)
    expect(with_.plans.length).toBeGreaterThan(0)
    expect(with_.plans[0]?.windows.length).toBeGreaterThan(0)
    expect(with_.plans[0]?.account).toBeNull()
    expect(
      snapshotOf(input({ reach: reach(['spend', 'accounts']) }), NOW).plans[0]?.account,
    ).not.toBeNull()
    expect(snapshotOf(input({ reach: reach([]) }), NOW).plans).toEqual([])
  })
})

describe('the page’s copy of it', () => {
  it('is the same table', () => {
    expect(PAGE).toEqual(WITHHOLDS)
    for (const grant of GRANTS)
      for (const path of WITHHOLDS[grant]) expect(pageGrantOf(path)).toBe(grant)
  })

  it('answers by what this device was sent, and refuses a place it does not know', () => {
    const store = { you: { reads: ['spend'] } }
    expect(mayFor(store, 'plans')).toBe(true)
    expect(mayFor(store, 'tasks.account')).toBe(false)
    expect(() => mayFor(store, 'tasks.state')).toThrow()
  })

  it('is the only way a page asks what it may read', () => {
    const folder = join(import.meta.dirname, '../src/assets')
    const asked = /mayFor\([^,]+, '([^']+)'\)/g
    const named = new RegExp(`\\bmay\\.(${GRANTS.join('|')})\\b|\\bmayRead\\(`)
    let paths = 0
    for (const file of scripts(folder)) {
      const text = readFileSync(join(folder, file), 'utf8')
      // `store.js` defines `mayRead` and `boot.js` builds the view's flags from it.
      if (file !== 'store.js' && file !== 'boot.js') expect(named.test(text), file).toBe(false)
      for (const [, path] of text.matchAll(asked)) {
        expect(grantOf(path ?? ''), `${file}: ${path}`).not.toBeNull()
        paths++
      }
    }
    expect(paths).toBeGreaterThan(10)
  })
})
