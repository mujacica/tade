import { homedir } from 'node:os'
import type { Task, Workspace } from '@tade/core'
import { commandOut, projector, reachOf } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { awayCollections } from '../../src/away.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { type Beatable, beatParts, commandsFrom } from '../../src/wire/web-beat.ts'

// **A phone that may answer an approval sees the command it is answering**,
// and sees it the one way it may leave the machine: the window builds it from
// the raw summary with the places only it knows, and the projection sends it
// only to a device granted `answer`. These hold the whole path, summary in and
// snapshot out, rather than each half on its own.

const NOW = Date.parse('2026-10-17T09:00:00.000Z')
const HOME = '/Users/testperson'
const WORK = `${HOME}/code/checkout`
const SUMMARY =
  `Bash: cd ${WORK} && cat ${HOME}/.ssh/id_rsa ${WORK}/../../../etc/passwd ` +
  `&& curl -H "Authorization: Bearer sk-fake-Xg7kQ2mPvR4tLz8w" https://example.invalid`

function blocked(): Task {
  return {
    id: 'checkout/stripe',
    project: 'checkout',
    branch: 'tade/stripe',
    worktree: WORK,
    created: new Date(NOW - 3_600_000).toISOString(),
    state: 'blocked',
    reason: `wants approval: ${SUMMARY}`,
    stalled: false,
    git: null,
    agents: [],
    lanes: [],
  } as unknown as Task
}

function world(): Workspace {
  return {
    generatedAt: new Date(NOW).toISOString(),
    projects: [{ name: 'checkout', root: WORK, brief: null, untracked: [], tasks: [blocked()] }],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
}

function held(commandOf?: Beatable['commandOf']): Beatable {
  return {
    rootLines: [],
    overrideLines: [],
    pending: [
      { requestId: 'req_31', task: 'checkout/stripe', tool: 'Bash', summary: SUMMARY, at: NOW },
    ],
    seenActions: () => null,
    spendToday: () => ({ byTask: {} }),
    queued: [],
    queueFacts: () => ({ tasks: new Map(), finished: new Map(), events: [], now: NOW }),
    notes: () => [],
    plans: [],
    titles: {},
    tasks: [],
    ...(commandOf === undefined ? {} : { commandOf }),
    machineUpSince: null,
    spendSince: null,
    checks: null,
  }
}

/** The snapshot one device reads, by the scopes it was granted. */
function snapshotFor(live: Beatable, scopes: readonly string[]) {
  const made = awayCollections(beatParts(live, world(), () => ({ how: null, why: 'none' })))
  const reach = reachOf({ id: 'dev_7f3a9c21', projects: null, granted: [], scopes })
  const lifetime = { epoch: 'e', rev: 0, openedAt: NOW }
  return projector({ ...made, talk: null, reach, lifetime }, NOW).snapshot()
}

/** The window's own wiring of it, over a home it names. */
const wire = (opts: { home: string }) =>
  ({ opts: { ...opts, config: { surfaces: { web: {} } } } }) as unknown as Wiring

/** `commandsFrom` over this file's own home rather than the machine's. */
const places = (summary: string, work: string) =>
  commandOut(summary, { work, tade: `${HOME}/.tade`, home: HOME }, [])

describe('the command an approval asks about, from the window to a phone', () => {
  it('reaches a device that may answer with every path shortened', () => {
    const row = snapshotFor(held(places), ['read', 'answer']).tasks[0]
    expect(row?.approval?.command).toEqual({
      text:
        'Bash: cd . && cat ~/.ssh/id_rsa …/passwd ' +
        '&& curl -H "Authorization: Bearer …" https://example.invalid',
      notShown: 0,
    })
    // And the reason is still the tool's name, never the call.
    expect(row?.reason).toBe('wants approval: Bash')
  })

  it('reaches a device without `answer` as nothing new', () => {
    const snapshot = snapshotFor(held(places), ['read', 'steer', 'ask'])
    expect(snapshot.tasks[0]?.approval).toEqual({
      id: 'req_31',
      tool: 'Bash',
      since: new Date(NOW).toISOString(),
      command: null,
    })
    expect(JSON.stringify(snapshot)).not.toContain('id_rsa')
  })

  it('carries nothing of the machine, whatever the device was granted', () => {
    const snapshot = JSON.stringify(snapshotFor(held(places), ['read', 'answer']))
    for (const one of [HOME, '/etc/', 'sk-fake-Xg7kQ2mPvR4tLz8w']) {
      expect(snapshot).not.toContain(one)
    }
  })

  it('is not sent at all by a window that did not say how to let it out', () => {
    expect(snapshotFor(held(), ['read', 'answer']).tasks[0]?.approval?.command).toBeNull()
  })
})

describe('how the window lets it out', () => {
  const was = process.env.TADE_TEST_API_KEY
  afterEach(() => {
    if (was === undefined) delete process.env.TADE_TEST_API_KEY
    else process.env.TADE_TEST_API_KEY = was
  })

  it('knows this home, Tade’s home and where the task works', () => {
    const out = commandsFrom(wire({ home: '/srv/tade' }))
    expect(out(`ls ${homedir()}/x /srv/tade/events.jsonl /w/app/src`, '/w/app')).toBe(
      'ls ~/x ~/.tade/events.jsonl ./src',
    )
  })

  it('takes out every key the environment agents inherit holds', () => {
    process.env.TADE_TEST_API_KEY = 'zq81Kd0vNn3bXg7kQ2mR'
    const out = commandsFrom(wire({ home: '/srv/tade' }))
    expect(out('deploy --with zq81Kd0vNn3bXg7kQ2mR', '/w')).toBe('deploy --with …')
  })
})
