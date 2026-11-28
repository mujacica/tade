import { homedir } from 'node:os'
import type { TadeEvent, Task, Workspace } from '@tade/core'
import { projector, reachOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { awayCollections } from '../../src/away.ts'
import { SINCE_LINES, StateSince, sinceOf } from '../../src/away-since.ts'
import type { Wiring } from '../../src/wire/context.ts'
import {
  type Beatable,
  beatParts,
  commandsFrom,
  doingOut,
  doingsOf,
} from '../../src/wire/web-beat.ts'

// **What every agent is doing, and since when, on a phone** — the two fields an
// agent's row on the overview carries beyond its state: the newest tool call
// the window watched it make, let out as an approval's command is, and the
// moment it began the state it is in, folded out of the journal.

const NOW = Date.parse('2026-11-28T09:00:00.000Z')
const WORK = `${homedir()}/code/checkout`

function working(): Task {
  return {
    id: 'checkout/stripe',
    project: 'checkout',
    branch: 'tade/stripe',
    worktree: WORK,
    created: new Date(NOW - 3_600_000).toISOString(),
    state: 'working',
    reason: 'agent running',
    stalled: false,
    git: null,
    agents: [],
    lanes: [],
  } as unknown as Task
}

function world(): Workspace {
  return {
    generatedAt: new Date(NOW).toISOString(),
    projects: [{ name: 'checkout', root: WORK, brief: null, untracked: [], tasks: [working()] }],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
}

function held(over: Partial<Beatable> = {}): Beatable {
  return {
    rootLines: [],
    overrideLines: [],
    pending: [],
    seenActions: () => null,
    spendToday: () => ({ byTask: {} }),
    queued: [],
    queueFacts: () => ({ tasks: new Map(), finished: new Map(), events: [], now: NOW }),
    notes: () => [],
    plans: [],
    titles: {},
    tasks: [],
    machineUpSince: null,
    spendSince: null,
    checks: null,
    ...over,
  }
}

/** The row a paired device reads. */
function rowFor(live: Beatable) {
  const made = awayCollections(beatParts(live, world(), () => ({ how: null, why: 'none' })))
  const reach = reachOf({ id: 'dev_7f3a9c21' })
  const lifetime = { epoch: 'e', rev: 0, openedAt: NOW }
  const [row] = projector({ ...made, talk: null, reach, lifetime }, NOW).snapshot().tasks
  if (row === undefined) throw new Error('no row')
  return row
}

const wire = (client: object = {}) =>
  ({
    opts: { home: `${homedir()}/.tade`, config: { surfaces: { web: {} } }, client },
  }) as unknown as Wiring

describe('what an agent is doing, on its row', () => {
  const call = {
    at: NOW - 4_000,
    tool: 'Bash',
    about: `cd ${WORK} && curl -H "Authorization: Bearer sk-fake-Xg7kQ2mPvR4tLz8w" https://x.invalid`,
    ok: null,
  }

  it('crosses as the tool, when, whether it worked, and what it was about as a command is let out', () => {
    const row = rowFor(
      held({
        doing: new Map([['checkout/stripe', call]]),
        commandOf: commandsFrom(wire()),
      }),
    )
    expect(row.doing).toMatchObject({ tool: 'Bash', at: new Date(call.at).toISOString(), ok: null })
    // Where the task works is `.`, and the key is not in it.
    expect(row.doing?.about).toContain('cd .')
    expect(row.doing?.about).not.toContain('sk-fake-Xg7kQ2mPvR4tLz8w')
    expect(row.doing?.about).not.toContain(homedir())
  })

  it('says nothing of what a call was about where the window has no way to clean it', () => {
    const row = rowFor(held({ doing: new Map([['checkout/stripe', call]]) }))
    expect(row.doing).toMatchObject({ tool: 'Bash', about: '' })
    expect(doingOut(undefined, () => 'x')).toBeNull()
  })

  it('is null where the window saw no call', () => {
    expect(rowFor(held()).doing).toBeNull()
  })

  it('reads the newest call of any run of a task, and none from a client with no supervisor', () => {
    const client = {
      workers: {
        doingByTask: () => [
          { task: 'a/one', run: 'r1', did: [{ ...call, at: 5, tool: 'Read' }], ends: [] },
          { task: 'a/one', run: 'r2', did: [{ ...call, at: 9, tool: 'Edit' }], ends: [] },
          { task: 'a/two', run: 'r3', did: [], ends: [] },
        ],
      },
    }
    const doings = doingsOf(wire(client))
    expect(doings.get('a/one')?.tool).toBe('Edit')
    expect(doings.has('a/two')).toBe(false)
    expect(doingsOf(wire()).size).toBe(0)
  })
})

describe('since when an agent is in its state', () => {
  it('is the newest of the journal’s lines, an approval waiting, and the journal saying finished', () => {
    const turn = NOW - 20 * 60_000
    expect(rowFor(held({ stateSince: () => turn })).since).toBe(new Date(turn).toISOString())
    const asked = NOW - 60_000
    const row = rowFor(
      held({
        stateSince: () => turn,
        pending: [
          { requestId: 'r', task: 'checkout/stripe', tool: 'Bash', summary: 'Bash: ls', at: asked },
        ],
      }),
    )
    expect(row.since).toBe(new Date(asked).toISOString())
    expect(rowFor(held()).since).toBeNull()
    expect(sinceOf(turn, null, new Date(NOW).toISOString())).toBe(NOW)
    expect(sinceOf(null, null, 'not a date')).toBeNull()
  })

  it('folds the lines a state begins at, the newest per task, and only the agent’s own lane', () => {
    const line = (type: string, at: number, over: Partial<TadeEvent> = {}) =>
      ({
        seq: 0,
        ts: new Date(at).toISOString(),
        type,
        task: 'a/one',
        lane: null,
        ...over,
      }) as TadeEvent
    const fold = new StateSince()
    fold.add(line('turn_started', 10_000))
    fold.add(line('turn_done', 30_000))
    // Out of order, as two reads can hand them: the newest stands.
    fold.add(line('run_started', 20_000))
    // Not a line a state begins at, a shell beside the agent, no task, no moment.
    fold.add(line('tool_call', 90_000))
    fold.add(line('lane_exited', 80_000, { lane: 'a/one/shell' }))
    fold.add(line('turn_done', 70_000, { task: null }))
    fold.add(line('turn_done', 0, { ts: 'never' }))
    expect(fold.of('a/one')).toBe(30_000)
    fold.add(line('lane_exited', 40_000, { lane: 'a/one/agent' }))
    expect(fold.of('a/one')).toBe(40_000)
    expect(fold.of('a/two')).toBeNull()
    expect([...SINCE_LINES]).toContain('run_exited')
  })
})
