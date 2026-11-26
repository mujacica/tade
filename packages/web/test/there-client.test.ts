import { afterEach, describe, expect, it } from 'vitest'
import { StillDocument } from '../scripts/still-dom.ts'
import { taskScreen } from '../src/assets/pages/agent.js'
import { projectScreen } from '../src/assets/pages/project.js'
import { applyCopy, applySnapshot, emptyStore } from '../src/assets/store.js'
import { linksThere, thereOn } from '../src/assets/there.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, reach, task } from './fixtures.ts'

// Another machine's project and task, drawn out of the copy of it this door
// keeps (`/m/<machine>/…`, ONE-AWAY-VIEW §2.4): that machine's own rows under
// a line saying whose and as of when, nothing to press, every link that
// machine's — and a task this machine has under the same name never drawn in
// its place.

const was = { document: Reflect.get(globalThis, 'document') }
afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
})

/** A page whose door holds a copy of mac, mac as it is seen; this machine has a `tade/one` of its own. */
function drawn(path: { view: string; project: string; task?: string }, state: 'up' | 'closed') {
  const doc = new StillDocument()
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  const store = emptyStore()
  const machines = [{ name: 'mac', way: 'from' as const, state, since: NOW - 60_000 }]
  applySnapshot(
    store,
    snapshotOf(
      input({
        reach: reach(EVERY),
        machines,
        tasks: [task({ id: 'tade/one', project: 'tade', title: 'this machine’s own' })],
      }),
      NOW,
    ),
  )
  const theirs = snapshotOf(
    input({
      reach: reach(EVERY),
      tasks: [
        task({ id: 'tade/one', project: 'tade', title: 'the mac’s one', state: 'blocked' }),
        task({ id: 'tade/two', project: 'tade' }),
      ],
    }),
    NOW - 60_000,
  )
  applyCopy(store, { v: PROTOCOL_VERSION, machine: 'mac', kind: 'whole', snapshot: theirs })
  // As the router builds it: the page's own screen, with no `ctx`.
  const at = { ...path, machine: 'mac' }
  const screen = thereOn(at, (path.view === 'task' ? taskScreen : projectScreen)(at, null))
  doc.body.append(screen.node)
  screen.update({ store, standing: 'live', asOf: NOW, frozen: false, now: NOW, may: {} })
  return { doc, screen }
}

describe('another machine’s task', () => {
  it('is that machine’s, under a line naming it, with nothing to press', () => {
    const { doc } = drawn({ view: 'task', project: 'tade', task: 'one' }, 'up')
    const line = doc.querySelector('.there-line')
    expect(line?.textContent).toMatch(/^mac · up since /)
    expect(doc.body.textContent).toContain('the mac’s one')
    expect(doc.body.textContent).not.toContain('this machine’s own')
    expect(doc.querySelector('.is-there-down')).toBeNull()
    expect(doc.querySelector('.ag-acts button')).toBeNull()
    expect(doc.querySelector('#ag-screen textarea')).toBeNull()
  })

  it('leads back to that machine’s project, and to nothing of this door’s that is not it', () => {
    const { doc } = drawn({ view: 'task', project: 'tade', task: 'one' }, 'up')
    const hrefs = doc.querySelectorAll('a[href]').map((one) => one.getAttribute('href') ?? '')
    expect(hrefs).toContain('/m/mac/p/tade')
    for (const href of hrefs) {
      if (href.startsWith('/') && href !== '/') expect(href, href).toMatch(/^\/m\/mac\//)
    }
  })

  it('is dimmed and as of its last word where that machine is not up', () => {
    const { doc } = drawn({ view: 'task', project: 'tade', task: 'one' }, 'closed')
    expect(doc.querySelector('.there-line')?.textContent).toMatch(/^mac · closed .+ · as of /)
    expect(doc.querySelector('.is-there-down')).not.toBeNull()
  })
})

describe('another machine’s project', () => {
  it('lists that machine’s tasks, each leading to its page there', () => {
    const { doc } = drawn({ view: 'project', project: 'tade' }, 'up')
    const tasks = doc
      .querySelectorAll('a[href]')
      .map((one) => one.getAttribute('href') ?? '')
      .filter((href) => href.includes('/t/'))
    expect(tasks.length).toBeGreaterThan(0)
    for (const href of tasks) expect(href).toMatch(/^\/m\/mac\/t\/tade\//)
  })
})

describe('a link on a machine’s screen', () => {
  it('is that machine’s, an anchor or the overview as it was, and words where it is this door’s', () => {
    const doc = new StillDocument()
    const node = doc.createElement('div')
    for (const href of ['/t/tade/one', '/findings', '#pj-checks', '/']) {
      const link = doc.createElement('a')
      link.setAttribute('href', href)
      node.append(link)
    }
    linksThere(node, 'mac')
    expect(node.children.map((one) => one.getAttribute('href'))).toEqual([
      '/m/mac/t/tade/one',
      null,
      '#pj-checks',
      '/',
    ])
  })

  it('leaves a screen of this machine’s as the router built it', () => {
    const built = { node: null, update() {}, leave() {} }
    expect(thereOn({ view: 'task', project: 'tade', task: 'one' }, built)).toBe(built)
    expect(thereOn({ view: 'findings', machine: 'mac' }, built)).toBe(built)
  })
})
