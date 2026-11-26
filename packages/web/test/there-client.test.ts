import { afterEach, describe, expect, it } from 'vitest'
import { StillDocument } from '../scripts/still-dom.ts'
import { taskScreen } from '../src/assets/pages/agent.js'
import { projectScreen } from '../src/assets/pages/project.js'
import { applyCopy, applySnapshot, emptyStore } from '../src/assets/store.js'
import { linksThere, THERE_VERBS, thereCtx, thereOn } from '../src/assets/there.js'
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
function drawn(
  path: { view: string; project: string; task?: string },
  state: 'up' | 'closed',
  ctx: unknown = null,
) {
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
  const screen = thereOn(at, (path.view === 'task' ? taskScreen : projectScreen)(at, ctx as never))
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

/** The page's own `ctx`, answering every ask with `answer` and keeping what was asked. */
function door(
  answer: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, said: 'parked there' },
  },
) {
  const asked: { method: string; path: string; body: unknown }[] = []
  const ctx = {
    ask: async (method: string, path: string, body: unknown) => {
      asked.push({ method, path, body })
      return answer
    },
    sentence: () => '',
    revOf: () => 4,
  }
  return { ctx, asked }
}

describe('a press on another machine’s row', () => {
  const EVERY = { task: 'tade/one', was: 'r1', key: 'k'.repeat(32), rev: 4 }

  it('is carried through this door as the press that machine’s outbox takes', async () => {
    const { ctx, asked } = door()
    const there = thereCtx(ctx, 'mac')
    expect(there.machine).toBe('mac')
    const sent = [
      ['steer', { said: 'look at the test first' }],
      ['stop', { confirm: true }],
      ['park', { parked: true }],
      ['note', { text: 'the flake is the clock' }],
      ['queue', { change: 'pause' }],
      ['remove', { confirm: true }],
    ] as const
    for (const [verb, fields] of sent) {
      const answer = await there.ask('POST', `/api/act/${verb}`, { ...EVERY, ...fields })
      expect(answer).toEqual({ status: 200, body: { ok: true, said: 'parked there' } })
    }
    expect(asked.map((one) => one.path)).toEqual(Array(6).fill('/api/there/press'))
    expect(asked.map((one) => one.body)).toEqual([
      {
        machine: 'mac',
        key: EVERY.key,
        verb: 'steer',
        task: 'tade/one',
        said: 'look at the test first',
      },
      { machine: 'mac', key: EVERY.key, verb: 'stop', task: 'tade/one', confirm: true },
      { machine: 'mac', key: EVERY.key, verb: 'park', task: 'tade/one', parked: true },
      {
        machine: 'mac',
        key: EVERY.key,
        verb: 'note',
        task: 'tade/one',
        text: 'the flake is the clock',
      },
      { machine: 'mac', key: EVERY.key, verb: 'queue', task: 'tade/one', change: 'pause' },
      // The window's Remove agent is the outbox's close, which keeps what is not merged.
      { machine: 'mac', key: EVERY.key, verb: 'close', task: 'tade/one' },
    ])
  })

  it('asks this door nothing for what that machine’s outbox does not take, and says so', async () => {
    const { ctx, asked } = door()
    const there = thereCtx(ctx, 'mac')
    for (const [path, body] of [
      ['/api/act/answer', { ...EVERY, allow: true }],
      ['/api/act/done', { ...EVERY, confirm: true }],
      ['/api/act/start', EVERY],
      ['/api/act/queue', { ...EVERY, change: 'start' }],
      ['/api/agent/tade/one/menu', {}],
    ] as const) {
      const answer = await there.ask('POST', path, body)
      expect(answer, path).toEqual({
        status: 409,
        body: { error: 'there', said: 'mac takes that only at its own screen: ask Tade' },
      })
    }
    expect((await there.ask('GET', '/api/act/park', undefined)).status).toBe(409)
    expect(asked).toEqual([])
  })

  it('answers what that machine would not do in its own words', async () => {
    const { ctx } = door({ status: 200, body: { ok: false, said: 'mac is closed since 14:02' } })
    const answer = await thereCtx(ctx, 'mac').ask('POST', '/api/act/park', {
      ...EVERY,
      parked: true,
    })
    expect(answer).toEqual({
      status: 409,
      body: { error: 'there', said: 'mac is closed since 14:02' },
    })
    // And this door's own refusal as it came.
    const refused = { status: 403, body: { error: 'out_of_scope' } }
    expect(await thereCtx(door(refused).ctx, 'mac').ask('POST', '/api/act/park', EVERY)).toBe(
      refused,
    )
  })

  it('draws on that machine’s task only the controls its outbox takes, and nothing that asks this door', () => {
    const { ctx, asked } = door()
    const { doc } = drawn(
      { view: 'task', project: 'tade', task: 'one' },
      'up',
      thereCtx(ctx, 'mac'),
    )
    const headings = doc.querySelectorAll('#ag-acts h2').map((one) => one.textContent)
    expect(headings).toEqual(['ACTIONS', 'IN THE QUEUE', 'A NOTE', 'SET ASIDE', 'ITS AGENT'])
    expect(THERE_VERBS).toEqual(['steer', 'stop', 'park', 'note', 'queue', 'remove'])
    // The box to tell its agent something, and no screen of this door's, no menu.
    expect(doc.querySelector('#ag-screen textarea')).not.toBeNull()
    expect(doc.querySelector('[aria-haspopup="dialog"]')).toBeNull()
    expect(asked).toEqual([])
  })
})
