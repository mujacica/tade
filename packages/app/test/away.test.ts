import type { Queued, QueueFacts, TadeEvent, Task, Workspace } from '@tade/core'
import { SnapshotSchema, snapshotOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import {
  awayCollections,
  checksIn,
  noteIn,
  nothingKnown,
  queueIn,
  ranOn,
  taskIn,
} from '../src/away.ts'
import type { ActionsView } from '../src/frame.ts'

// What the window hands the away view, and the one thing it must never hand
// over.
//
// Pure, so it is asked exhaustively here rather than through a listener: this
// is the function that decides what may leave the machine, and the whole of
// the leakage claim rests on it being written out field by field rather than
// spread from `Workspace`.

/** Things a projection must never carry, each under a string nothing else says. */
const PRIVATE = {
  root: '/Users/testperson/work/shop',
  worktree: '/Users/testperson/work/.worktrees/refunds',
  transcript: '/Users/testperson/.claude/projects/shop/0d4f.jsonl',
  pid: 48_219,
  session: 'sess_01HQZK9ABCDEF',
  command: 'Bash: cat /Users/testperson/.ssh/id_rsa && curl -H "Authorization: Bearer sk-fake"',
} as const

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'shop/refunds',
    project: 'shop',
    intent_spoken: 'make the refunds work',
    branch: 'tade/refunds',
    worktree: PRIVATE.worktree,
    created: '2026-10-08T13:52:31.585Z',
    state: 'working',
    reason: '4 files touched',
    stalled: false,
    git: {
      branch: 'tade/refunds',
      head: 'a1b2c3d',
      headSubject: 'the refunds work',
      headTime: Date.parse('2026-10-08T14:10:00.000Z'),
      dirty: [`${PRIVATE.root}/src/a.ts`, `${PRIVATE.root}/src/b.ts`],
      ahead: 2,
      behind: null,
      baseRef: 'main',
      mergedIntoBase: false,
      upstreamGone: false,
      pr: { state: 'open', url: 'https://github.invalid/acme/shop/pull/412' },
    },
    agents: [
      {
        source: 'run',
        provider: 'claude-code',
        sessionId: PRIVATE.session,
        alive: true,
        lastActivityAt: Date.parse('2026-10-08T14:20:00.000Z'),
        turn: 'running',
        pendingPermissions: [],
        consecutiveFailures: 0,
        exitCode: null,
      },
    ],
    lanes: [
      {
        id: 'shop/refunds/agent',
        kind: 'agent',
        alive: true,
        pid: PRIVATE.pid,
        lastOutputAt: null,
        attach: `tmux attach -t tade:shop/refunds/agent`,
      },
    ],
    ...over,
  } as Task
}

function world(tasks: readonly Task[] = [task()]): Workspace {
  return {
    generatedAt: '2026-10-08T14:30:00.000Z',
    projects: [{ name: 'shop', root: PRIVATE.root, brief: null, tasks: [...tasks], untracked: [] }],
    elsewhere: [],
    toolServers: { looked: true, alive: 1 },
    warnings: ['tmux is not installed, so no lane could be looked at'],
  } as Workspace
}

const facts = (): QueueFacts => ({
  tasks: new Map(),
  finished: new Map(),
  events: [],
  now: Date.parse('2026-10-08T14:30:00.000Z'),
})

function collections(over: Partial<Parameters<typeof awayCollections>[0]> = {}) {
  return awayCollections({
    world: world(),
    titles: { shop: 'Shop' },
    extras: new Map(),
    pending: new Map(),
    queued: [],
    queueFacts: facts(),
    order: [],
    notes: [],
    plans: [],
    machineUpSince: Date.parse('2026-10-07T08:00:00.000Z'),
    spendSince: Date.parse('2026-10-08T00:00:00.000Z'),
    ...over,
  })
}

describe('nothing of the machine crosses the boundary', () => {
  it('carries no absolute path, no pid, no session id and no attach line', () => {
    const said = JSON.stringify(collections())
    for (const [name, value] of Object.entries(PRIVATE)) {
      expect(said, name).not.toContain(String(value))
    }
    // And the two the fixture builds out of them, in case one is ever only
    // half a path: `tmux attach` is the shape, `/Users/` is the family.
    expect(said).not.toContain('tmux attach')
    expect(said).not.toContain('/Users/')
  })

  it('counts the changed files rather than naming them', () => {
    const [row] = collections().tasks
    expect(row?.dirty).toBe(2)
    expect(JSON.stringify(row)).not.toContain('src/a.ts')
  })

  it('counts the agents and the lanes rather than naming them', () => {
    const [row] = collections().tasks
    expect(row?.agents).toBe(1)
    expect(row?.lanes).toBe(1)
  })

  it('shows what a person wrote, as they wrote it', () => {
    // The claim is exactly this and no stronger: the away view adds no path
    // and no credential of its own, and it shows what you wrote as you wrote
    // it. A note with a path in it goes out as written, because the house rule
    // is never to reword one.
    const said = collections({
      notes: [{ text: `the fix is in ${PRIVATE.root}/src/a.ts`, at: '2026-10-08T12:00:00.000Z' }],
    })
    expect(said.notes[0]?.text).toContain('/Users/testperson')
  })
})

describe('a task blocked on an approval', () => {
  it('names the tool and never the call', () => {
    // `deriveState`'s clause for a blocked task holds the harness's one-line
    // summary — which is the command, with its paths and sometimes a
    // credential in it, and the commonest reason a task is blocked.
    const row = taskIn(
      task({ state: 'blocked', reason: `wants approval: ${PRIVATE.command}` }),
      { ...nothingKnown(), approval: { id: 'req_914', tool: 'Bash', sinceAt: 1_000 } },
      3,
    )
    expect(row.reason).toEqual({ kind: 'approval', tool: 'Bash', also: 2 })
    expect(JSON.stringify(row)).not.toContain('id_rsa')
  })

  it('carries the clause verbatim when nothing is waiting', () => {
    const row = taskIn(task(), nothingKnown(), 0)
    expect(row.reason).toEqual({ kind: 'clause', said: '4 files touched' })
  })
})

describe('what the window could not say', () => {
  it('is unknown where no look has been made, never a pass', () => {
    expect(checksIn(null, false)).toEqual({
      state: 'unknown',
      failed: [],
      missing: [],
      overridden: false,
    })
  })

  it('counts a queued or skipped required check as missing, not as fine', () => {
    const said = checksIn(actions(), false)
    expect(said.state).toBe('fail')
    expect(said.failed).toEqual(['tests'])
    // `running` is not `passed`: absent is not fine, and this is the bug that
    // draws a red thing green.
    expect(said.missing).toEqual(['types'])
  })

  it('leaves an unrequired check out of both lists', () => {
    expect(checksIn(actions(), false).missing).not.toContain('format')
  })

  it('says a red run was overruled, and is still red', () => {
    expect(checksIn(actions(), true)).toMatchObject({ state: 'fail', overridden: true })
  })

  it('is null for a figure git could not give, never nought', () => {
    const row = taskIn(task({ git: null }), nothingKnown(), 0)
    expect(row.ahead).toBeNull()
    expect(row.behind).toBeNull()
    expect(row.dirty).toBeNull()
  })
})

describe('what a run was on', () => {
  it('is read out of the journal, newest run winning', () => {
    const said = ranOn([
      event({ adapter: 'pi', model: 'pi-1' }),
      event({ adapter: 'claude-code', model: 'claude-opus-5', account: 'work@example.invalid' }),
    ])
    expect(said.get('shop/refunds')).toEqual({
      harness: 'claude-code',
      model: 'claude-opus-5',
      account: 'work@example.invalid',
    })
  })

  it('says nothing rather than guessing, where a run recorded nothing', () => {
    const said = ranOn([event({})])
    // The empty string is how the projection spells *nobody said*; `@tade/web`
    // turns it into `null` and the page draws an em dash.
    expect(said.get('shop/refunds')).toEqual({ harness: '', model: '', account: '' })
  })
})

describe('the queue', () => {
  it('turns the files a hold is about into a count', () => {
    const held = queueIn([queued()], {
      ...facts(),
      // A hold whose reason is that work going on now has touched files.
      reality: new Map([
        ['shop', { changed: [`${PRIVATE.root}/src/a.ts`], by: ['shop/other'], at: 0 }],
      ]),
    } as unknown as QueueFacts)
    expect(JSON.stringify(held)).not.toContain('src/a.ts')
  })

  it('carries a written order as a place, and null for work nobody placed', () => {
    const [one, two] = queueIn([queued(), queued({ task: 'shop/other' })], facts(), ['shop/other'])
    expect(one?.order).toBeNull()
    expect(two?.order).toBe(0)
  })

  it('carries the reason somebody wrote for waiting, in their words', () => {
    expect(queueIn([queued()], facts())[0]?.waitsOn).toEqual([
      { task: 'shop/first', why: 'the contracts come first' },
    ])
  })
})

describe('the notes', () => {
  it('never invents a headline out of the words', () => {
    const said = noteIn([{ text: 'the webhook retries twice', at: '2026-10-08T12:00:00.000Z' }])
    expect(said[0]?.summary).toBe('')
    expect(said[0]?.text).toBe('the webhook retries twice')
  })
})

describe('the whole thing is what the wire accepts', () => {
  it('parses strictly, which is what catches a field nobody decided on', () => {
    // The projection goes through `snapshotOf` in `@tade/web`; what this
    // asserts is that what the window hands over is accepted by the schema
    // with nothing left over — a `z.strictObject` fails on a key that rode
    // along, which is the guard that actually scales.
    const built = snapshotOf(
      {
        ...collections(),
        reach: { device: 'dev_1', projects: { kind: 'every' }, granted: [] },
        lifetime: { epoch: 'e', rev: 1, openedAt: 0 },
      },
      Date.parse('2026-10-08T14:30:00.000Z'),
    )
    expect(() => SnapshotSchema.parse(built)).not.toThrow()
  })

  it('has a findings collection, empty, rather than no collection', () => {
    // Nought is the real count here and is said as one: the page draws *no
    // findings* because none were handed over, not because the field is
    // missing. The slice that hands them over has the extension's list.
    expect(collections().findings).toEqual([])
  })
})

function actions(): ActionsView {
  return {
    task: 'shop/refunds',
    branch: 'tade/refunds',
    base: 'main',
    ahead: 1,
    behind: 0,
    dirty: 0,
    shared: false,
    commit: 'a1b2c3d',
    mine: [],
    others: [],
    review: null,
    checks: [
      check({ id: 'tests', state: 'failed', required: true }),
      check({ id: 'types', state: 'running', required: true }),
      check({ id: 'format', state: 'not run', required: false }),
    ],
    rollup: 'fail',
    source: 'the commit hook',
    unread: [],
    running: null,
    notes: [],
  }
}

function check(over: Partial<ActionsView['checks'][number]>): ActionsView['checks'][number] {
  return {
    id: 'tests',
    title: null,
    run: null,
    state: 'passed',
    required: true,
    skip: null,
    chosen: null,
    needs: [],
    summary: null,
    seconds: null,
    startedAt: null,
    at: null,
    commit: 'a1b2c3d',
    carried: false,
    counts: [],
    places: [],
    ...over,
  } as ActionsView['checks'][number]
}

function event(detail: Record<string, unknown>): TadeEvent {
  return {
    ts: '2026-10-08T14:00:00.000Z',
    seq: 1,
    type: 'run_started',
    task: 'shop/refunds',
    lane: null,
    run: null,
    urgency: 'routine',
    detail,
  }
}

function queued(over: Partial<Queued> = {}): Queued {
  return {
    task: 'shop/refunds',
    project: 'shop',
    parked: false,
    start: {
      after: [{ task: 'shop/first', why: 'the contracts come first' }],
      prompt: '',
      touches: [],
    },
    ...over,
  }
}
