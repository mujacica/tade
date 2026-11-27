import { afterEach, describe, expect, it } from 'vitest'
import { StillDocument } from '../scripts/still-dom.ts'
import { agentsScreen } from '../src/assets/agents.js'
import {
  chipsOf,
  drawsOf,
  HERE,
  navCountsOf,
  pickedIn,
  reviewsOnce,
  storesDrawn,
} from '../src/assets/machines.js'
import { boardOf } from '../src/assets/pages/overview-figures.js'
import { queueScreen } from '../src/assets/pages/queue.js'
import { reviewsScreen } from '../src/assets/pages/reviews.js'
import { sideOf } from '../src/assets/side.js'
import { applyCopy, applySnapshot, emptyStore } from '../src/assets/store.js'
import { everyMachine, machineChips, machinePicked } from '../src/assets/there.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { blocked, input, NOW, queued, reach, task } from './fixtures.ts'

// Every machine's rows on one page (ONE-AWAY-VIEW §2.4): the machine chips —
// All · This machine · each other — over the side, the overview and every list
// page; another machine's rows drawn by the same screen out of its copy, under
// a line naming it, its links that machine's; and a review two machines have
// is one review.

const was = { document: Reflect.get(globalThis, 'document') }
afterEach(() => {
  // The pick is the page's, kept across screens: put back to All, as a person would.
  const doc = page()
  const chips = machineChips()
  doc.body.append(chips.node)
  chips.update(storeOf(true))
  pick(doc, 'All')
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
})

const PR = 'https://github.invalid/acme/tade/pull/7'

/** A door with `tade/one` of its own and, where `linked`, a copy of mac with `tade/two`. */
function storeOf(linked: boolean, state: 'up' | 'closed' = 'up') {
  const store = emptyStore()
  const machines = linked ? [{ name: 'mac', way: 'from' as const, state, since: NOW - 60_000 }] : []
  const one = task({ id: 'tade/one', project: 'tade', title: 'this machine’s own' })
  applySnapshot(
    store,
    snapshotOf(
      input({
        reach: reach(),
        machines,
        tasks: [{ ...one, review: { state: 'open', url: PR } }],
        queue: [queued({ task: 'tade/one', project: 'tade' })],
      }),
      NOW,
    ),
  )
  if (!linked) return store
  const two = task({ id: 'tade/two', project: 'tade', title: 'the mac’s two' })
  const theirs = snapshotOf(
    input({
      reach: reach(),
      tasks: [{ ...two, review: { state: 'open', url: PR } }],
      queue: [queued({ task: 'tade/two', project: 'tade' })],
    }),
    NOW - 60_000,
  )
  applyCopy(store, { v: PROTOCOL_VERSION, machine: 'mac', kind: 'whole', snapshot: theirs })
  return store
}

function page() {
  const doc = new StillDocument()
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  return doc
}

const viewOf = (store: unknown) => ({
  store,
  standing: 'live',
  asOf: NOW,
  frozen: false,
  now: NOW,
  may: {},
  where: { view: 'queue' },
})

/** The links a person can see: none under anything hidden. */
const shownHrefs = (doc: StillDocument) =>
  doc
    .querySelectorAll('a[href]')
    .filter((one) => one.closest('[hidden]') === null && one.closest('.not-here') === null)
    .map((one) => one.getAttribute('href') ?? '')

/** Presses the chip whose words start with `label`, as a person would. */
function pick(doc: StillDocument, label: string) {
  const chip = doc
    .querySelectorAll('.machine-chips button')
    .find((one) => (one.getAttribute('aria-label') ?? '').startsWith(label))
  if (chip === undefined) throw new Error(`no chip ${label}`)
  chip.click()
}

describe('the machine chips', () => {
  it('are not drawn where only this machine is', () => {
    expect(chipsOf(storeOf(false), null)).toEqual([])
  })

  it('are All, this machine and each other, a state not up said in words', () => {
    const chips = chipsOf(storeOf(true, 'closed'), null)
    expect(chips.map((one) => one.label)).toEqual(['All', 'This machine', 'mac'])
    expect(chips[0]?.on).toBe(true)
    expect(chips[2]?.said).toMatch(/^closed /)
    expect(chips[2]?.tone).toBe('')
    expect(chipsOf(storeOf(true), 'mac')[2]).toMatchObject({ said: 'up', tone: 't-done', on: true })
  })

  it('fall back to All for a machine that is gone', () => {
    expect(pickedIn(storeOf(false), 'mac')).toBeNull()
    expect(pickedIn(storeOf(true), 'mac')).toBe('mac')
    expect(drawsOf(null, 'mac')).toBe(true)
    expect(drawsOf(HERE, null)).toBe(true)
    expect(drawsOf('mac', null)).toBe(false)
  })
})

describe('a list page', () => {
  it('draws only this machine’s rows, unmarked, where no other is linked', () => {
    const doc = page()
    const screen = everyMachine(queueScreen)
    doc.body.append(screen.node)
    screen.update(viewOf(storeOf(false)))
    expect(doc.querySelector('.machine-chips')?.hidden).toBe(true)
    expect(doc.querySelectorAll('.there-line').every((one) => one.hidden)).toBe(true)
  })

  it('draws every machine’s rows, each under its own line, another’s leading to its page there', () => {
    const doc = page()
    const screen = everyMachine(queueScreen)
    doc.body.append(screen.node)
    const store = storeOf(true)
    screen.update(viewOf(store))
    const lines = doc.querySelectorAll('.there-line').filter((one) => !one.hidden)
    expect(lines.map((one) => one.textContent)).toEqual([
      'This machine',
      expect.stringMatching(/^mac · up since /),
    ])
    const hrefs = doc.querySelectorAll('a[href]').map((one) => one.getAttribute('href') ?? '')
    expect(hrefs).toContain('/t/tade/one')
    expect(hrefs).toContain('/m/mac/t/tade/two')
    expect(hrefs).not.toContain('/t/tade/two')

    pick(doc, 'mac')
    expect(machinePicked(store)).toBe('mac')
    screen.update(viewOf(store))
    const now = shownHrefs(doc)
    expect(now).toContain('/m/mac/t/tade/two')
    expect(now).not.toContain('/t/tade/one')

    pick(doc, 'This machine')
    screen.update(viewOf(store))
    const mine = shownHrefs(doc)
    expect(mine).toContain('/t/tade/one')
    expect(mine).not.toContain('/m/mac/t/tade/two')
  })

  it('keeps the page’s own bar its top, the chips under it, another machine’s under its line alone', () => {
    const doc = page()
    const screen = everyMachine(queueScreen)
    doc.body.append(screen.node)
    const store = storeOf(true)
    screen.update(viewOf(store))
    const bar = doc.querySelector('.pg-bar')
    expect(bar?.closest('.there-box')).toBeNull()
    expect(bar?.nextElementSibling?.classList.contains('machine-chips')).toBe(true)
    pick(doc, 'mac')
    screen.update(viewOf(store))
    expect(doc.querySelector('.not-here .machine-chips')?.hidden).toBe(false)
  })

  it('dims another machine that is not up, as of its last word', () => {
    const doc = page()
    const screen = everyMachine(queueScreen)
    doc.body.append(screen.node)
    screen.update(viewOf(storeOf(true, 'closed')))
    expect(doc.querySelector('.is-there-down .there-line')?.textContent).toMatch(
      /^mac · closed .+ · as of /,
    )
  })

  it('draws another machine’s queued work by its real rows where its copy is held, not as Elsewhere here too', () => {
    const doc = page()
    const screen = everyMachine(queueScreen)
    doc.body.append(screen.node)
    const store = storeOf(true)
    // What this machine's own projection says of work queued on mac, and on box, of which no copy is held.
    const there = (machine: string) => ({
      task: `${machine}:tade/two`,
      project: 'tade',
      state: { kind: 'there', machine, heardAt: NOW - 60_000, silentDays: null },
      order: null,
      waitsOn: [],
    })
    for (const machine of ['mac', 'box'])
      store.rows.queue.set(`${machine}:tade/two`, there(machine))
    screen.update(viewOf(store))
    const names = (inside: boolean) =>
      doc
        .querySelectorAll('li .name')
        .filter((one) => (one.closest('.there-box') !== null) === inside)
        .map((one) => one.textContent)
    expect(names(false)).toEqual(['box:two', 'one'])
    expect(names(true)).toEqual(['two'])
  })
})

describe('a review two machines have', () => {
  it('is one review, on the machine drawn first, the other’s task named on it', () => {
    const store = storeOf(true)
    const copy = store.copies.get('mac')
    const [here, there] = reviewsOnce([
      { machine: HERE, store },
      { machine: 'mac', store: copy },
    ])
    expect(here.rows.tasks.get('tade/one').alsoOn).toEqual(['mac’s tade/two'])
    expect(there.rows.tasks.has('tade/two')).toBe(false)
    // The stores drawn from are never changed.
    expect(store.rows.tasks.get('tade/one').alsoOn).toBeUndefined()
    expect(copy.rows.tasks.has('tade/two')).toBe(true)
  })

  it('is drawn once on the reviews page, and as the other’s own where only it is picked', () => {
    const doc = page()
    const screen = everyMachine(reviewsScreen, null, reviewsOnce)
    doc.body.append(screen.node)
    const store = storeOf(true)
    screen.update(viewOf(store))
    const cards = doc.querySelectorAll('.rv-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.textContent).toContain('also mac’s tade/two')

    pick(doc, 'mac')
    screen.update(viewOf(store))
    const theirs = doc
      .querySelectorAll('.rv-card')
      .filter((one) => one.closest('[hidden]') === null && one.closest('.not-here') === null)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.querySelector('a')?.getAttribute('href')).toBe('/m/mac/t/tade/two')
  })
})

describe('the side', () => {
  it('draws another machine’s projects under its line, nothing to press, every link there', () => {
    const doc = page()
    const side = sideOf(null)
    doc.body.append(side.node)
    side.update({ ...viewOf(storeOf(true)), where: { view: 'now' } })
    const there = doc.querySelector('.side-there')
    expect(there?.querySelector('.there-line')?.textContent).toMatch(/^mac · up since /)
    const hrefs = (there?.querySelectorAll('a[href]') ?? []).map((one) => one.getAttribute('href'))
    expect(hrefs).toContain('/m/mac/p/tade')
    for (const href of hrefs) if (href !== '/') expect(href).toMatch(/^\/m\/mac\//)
  })
})

describe('the Agents page', () => {
  /** The links to an agent a person can see, as the page draws them. */
  const agentHrefs = (doc: StillDocument) =>
    doc
      .querySelectorAll('.agent-list > li > a')
      .filter((one) => one.closest('[hidden]') === null)
      .map((one) => one.getAttribute('href') ?? '')

  it('has the machine chips, and draws only the agents of the machine they pick', () => {
    const doc = page()
    const screen = agentsScreen(null)
    doc.body.append(screen.node)
    const store = storeOf(true)
    screen.update(viewOf(store))
    expect(doc.querySelector('.machine-chips')?.hidden).toBe(false)
    expect(agentHrefs(doc)).toEqual(['/t/tade/one', '/m/mac/t/tade/two'])
    expect(doc.querySelector('.there-line')?.hidden).toBe(false)
    expect(doc.querySelector('.figure')?.textContent).toBe('2')

    pick(doc, 'mac')
    screen.update(viewOf(store))
    expect(agentHrefs(doc)).toEqual(['/m/mac/t/tade/two'])
    expect(doc.querySelector('.there-line')?.hidden).toBe(true)
    expect(doc.querySelector('.figure')?.textContent).toBe('1')

    pick(doc, 'This machine')
    screen.update(viewOf(store))
    expect(agentHrefs(doc)).toEqual(['/t/tade/one'])
    expect(doc.querySelector('section.elsewhere')).toBeNull()
  })

  it('draws no chips and no line where only this machine is', () => {
    const doc = page()
    const screen = agentsScreen(null)
    doc.body.append(screen.node)
    screen.update(viewOf(storeOf(false)))
    expect(doc.querySelector('.machine-chips')?.hidden).toBe(true)
    expect(doc.querySelector('.there-line')?.hidden).toBe(true)
    expect(agentHrefs(doc)).toEqual(['/t/tade/one'])
  })
})

/** A door with an approval of its own and, on mac, one more: both want the person. */
function wantingOf(state: 'up' | 'closed') {
  const store = emptyStore()
  const machines = [{ name: 'mac', way: 'from' as const, state, since: NOW - 60_000 }]
  applySnapshot(
    store,
    snapshotOf(input({ reach: reach(), machines, tasks: [blocked()], intake: [] }), NOW),
  )
  const two = { ...blocked(), id: 'tade/two', project: 'tade' }
  const theirs = snapshotOf(input({ reach: reach(), tasks: [two], intake: [] }), NOW - 60_000)
  applyCopy(store, { v: PROTOCOL_VERSION, machine: 'mac', kind: 'whole', snapshot: theirs })
  return store
}

describe('the counts beside the navigation and the overview’s board', () => {
  it('are each machine’s the chips pick, as the pages they lead to draw them', () => {
    const store = storeOf(true)
    expect(storesDrawn(store, null).map((one) => one.machine)).toEqual([HERE, 'mac'])
    expect(storesDrawn(store, 'mac').map((one) => one.machine)).toEqual(['mac'])
    // A pick of a machine gone from the chips is All again.
    expect(storesDrawn(store, 'box').map((one) => one.machine)).toEqual([HERE, 'mac'])

    // A review both machines have is counted once.
    expect(navCountsOf(store, null)).toMatchObject({ agents: 2, queue: 2, reviews: 1 })
    expect(navCountsOf(store, HERE)).toMatchObject({ agents: 1, queue: 1, reviews: 1 })
    expect(navCountsOf(store, 'mac')).toMatchObject({ agents: 1, queue: 1, reviews: 1 })
    expect(boardOf(store, null).working.n).toBe(2)
    expect(boardOf(store, null).queue.n).toBe(2)
    expect(boardOf(store, 'mac').working.n).toBe(1)
    expect(boardOf(store, HERE).queue.n).toBe(1)
  })

  it('count what wants the person only where its machine is up, as NEEDS YOU does', () => {
    const up = wantingOf('up')
    expect(navCountsOf(up, null).wantsYou).toBe(2)
    expect(navCountsOf(up, 'mac').wantsYou).toBe(1)
    expect(boardOf(up, null).wants.n).toBe(2)
    expect(boardOf(up, null).wants.under).toBe('2 approvals')

    const closed = wantingOf('closed')
    expect(navCountsOf(closed, null).wantsYou).toBe(1)
    expect(navCountsOf(closed, 'mac').wantsYou).toBe(0)
    expect(boardOf(closed, null).wants.n).toBe(1)
    // Its rows are still on its pages, dimmed: an agent there is counted as drawn.
    expect(navCountsOf(closed, 'mac').agents).toBe(1)
    expect(boardOf(closed, 'mac').working.n).toBe(0)
  })

  it('do not count another machine’s queued work twice where its copy is held', () => {
    const store = storeOf(true)
    const there = {
      task: 'mac:tade/two',
      project: 'tade',
      state: { kind: 'there', machine: 'mac', heardAt: NOW - 60_000, silentDays: null },
      order: null,
      waitsOn: [],
    }
    store.rows.queue.set(there.task, there)
    expect(navCountsOf(store, null).queue).toBe(2)
    expect(boardOf(store, null).queue.n).toBe(2)
  })
})
