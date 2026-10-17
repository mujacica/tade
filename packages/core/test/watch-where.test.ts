import { describe, expect, it } from 'vitest'
import {
  ConfigSchema,
  describeLook,
  type TadeEvent,
  type WatchWhereFacts,
  watchedFrom,
  watchingIn,
  watchWhere,
} from '../src/index.ts'

// One machine per repository for every watch on an outside source
// (`watch-where.ts`, REMOTE-TADE.md §9.5): which machine looks, why, and what
// the one that does not look says about it.

const facts = (over: Partial<WatchWhereFacts> = {}): WatchWhereFacts => ({
  watch: 'review.branch-checks',
  project: 'app',
  outside: true,
  setting: undefined,
  remotes: ['vps'],
  told: new Set(['vps']),
  twins: [{ machine: 'vps', project: 'tade', watching: [] }],
  last: null,
  ...over,
})

describe('which machine looks with a watch', () => {
  it('leaves it to a remote that is looking with it on the same repository, whatever the project says', () => {
    const running = [{ machine: 'vps', project: 'tade', watching: ['review.branch-checks'] }]
    expect(watchWhere(facts({ twins: running }))).toEqual({
      here: false,
      on: 'vps',
      said: 'vps looks with it on the same repository (tade there), so this machine does not',
    })
    // `here` beside a machine that is looking is two machines looking, and the
    // one this machine can stop is its own: said, with what to turn off where.
    const here = watchWhere(facts({ twins: running, setting: 'here' }))
    expect(here).toMatchObject({ here: false, on: 'vps' })
    expect(here.here ? '' : here.said).toContain(
      'projects.app.watches says here, so turn it off on vps to have it look here',
    )
  })

  it('looks here with a watch that reads only this machine, wherever its repository is', () => {
    const running = [{ machine: 'vps', project: 'tade', watching: ['review.branch-checks'] }]
    expect(watchWhere(facts({ outside: false, twins: running }))).toEqual({ here: true })
  })

  it('looks here on a machine that links to nobody, and where no remote has the repository', () => {
    expect(watchWhere(facts({ remotes: [], told: new Set(), twins: [] }))).toEqual({ here: true })
    expect(watchWhere(facts({ twins: [] }))).toEqual({ here: true })
  })

  it('is the remote’s by default where the repository is a project there, and says what is missing there', () => {
    expect(watchWhere(facts())).toEqual({
      here: false,
      on: 'vps',
      said: "app's repository is a project on vps too (tade), so it is vps's to watch, which does not look with it: turn it on there, or set projects.app.watches to here",
    })
    // An older Tade there carries no list, which is not a list of none.
    const older = watchWhere(
      facts({ twins: [{ machine: 'vps', project: 'tade', watching: null }] }),
    )
    expect(older.here ? '' : older.said).toContain(
      'whose Tade does not say what it watches: update it there',
    )
  })

  it('looks here where the project says so and nobody there is looking', () => {
    expect(watchWhere(facts({ setting: 'here' }))).toEqual({ here: true })
  })

  it('leaves it to the remote the project names, and says what that remote has', () => {
    expect(watchWhere(facts({ setting: 'vps' }))).toEqual({
      here: false,
      on: 'vps',
      said: 'projects.app.watches leaves it to vps, which does not look with it: turn it on there',
    })
    const none = watchWhere(facts({ setting: 'vps', twins: [] }))
    expect(none.here ? '' : none.said).toBe(
      'projects.app.watches leaves it to vps, which has no project of this repository: open it there',
    )
    // Not heard from yet: named, and nothing guessed about it.
    const unheard = watchWhere(facts({ setting: 'vps', told: new Set(), twins: [] }))
    expect(unheard.here ? '' : unheard.said).toBe('projects.app.watches leaves it to vps')
  })

  it('reads a project naming a remote this machine no longer has as saying nothing', () => {
    expect(watchWhere(facts({ setting: 'gone', twins: [] }))).toEqual({ here: true })
  })

  it('keeps the last look’s answer until that machine has said, and decides again once it has', () => {
    const last = { on: 'vps', said: 'vps looks with it on the same repository (tade there)' }
    // The window opened and the link has not answered: the hold stands.
    const opening = facts({ told: new Set(), twins: [], last, setting: 'here' })
    expect(watchWhere(opening)).toEqual({ here: false, on: 'vps', said: last.said })
    // It answered, and nothing there looks with it: the project's answer stands.
    expect(watchWhere(facts({ last, setting: 'here' }))).toEqual({ here: true })
    // A remote that is gone from the config holds nothing.
    expect(watchWhere(facts({ remotes: [], told: new Set(), twins: [], last }))).toEqual({
      here: true,
    })
  })

  it('looks here where more than one remote has the repository and none is looking', () => {
    const twins = [
      { machine: 'vps', project: 'tade', watching: [] },
      { machine: 'box', project: 'tade', watching: [] },
    ]
    expect(
      watchWhere(facts({ remotes: ['vps', 'box'], told: new Set(['vps', 'box']), twins })),
    ).toEqual({
      here: true,
    })
  })

  it('is a setting a project can hold, `here` or a remote’s name, and nothing else', () => {
    const parsed = ConfigSchema.parse({ projects: { app: { root: '/r', watches: 'vps' } } })
    expect(parsed.projects.app?.watches).toBe('vps')
    expect(() =>
      ConfigSchema.parse({ projects: { app: { root: '/r', watches: '-oProxyCommand=x' } } }),
    ).toThrow()
  })
})

describe('what this machine says it watches', () => {
  const watch = (id: string, project: string, over: { paused?: boolean; watch?: string } = {}) => ({
    id,
    project,
    paused: over.paused ?? false,
    does: {
      kind: 'watch' as const,
      watch: over.watch ?? 'review.branch-checks',
      input: {},
      found: 'agent' as const,
      most: 1,
    },
  })
  const offers = [
    { id: 'review.branch-checks', about: 'repository' as const, problem: null },
    { id: 'sentry.new-errors', about: 'repository' as const, problem: 'set SENTRY_AUTH_TOKEN' },
    // A judge reaches a model somewhere else and reads this machine's agents.
    { id: 'jev.circles', about: 'machine' as const, problem: null },
  ]

  it('is every outside watch on and able to look, by project, and none left to another machine', () => {
    const left = new Set(['checks-web'])
    const watching = watchingIn(
      [
        watch('checks-app', 'app'),
        watch('checks-web', 'web'),
        watch('paused-app', 'app', { paused: true, watch: 'review.branch-checks' }),
        watch('sentry-app', 'app', { watch: 'sentry.new-errors' }),
        watch('circles-app', 'app', { watch: 'jev.circles' }),
        { id: 'daily', project: 'app', paused: false, does: { kind: 'ask', prompt: 'hi' } },
      ],
      offers,
      (id) => (left.has(id) ? 'vps' : null),
    )
    expect([...watching]).toEqual([['app', ['review.branch-checks']]])
  })
})

describe('a look left to another machine, in the journal', () => {
  const line = (detail: Record<string, unknown>, ts: string): TadeEvent =>
    ({
      seq: 0,
      ts,
      type: 'watch_checked',
      task: null,
      urgency: 'routine',
      detail: { schedule: 'checks-app', ...detail },
    }) as unknown as TadeEvent

  it('says which machine, drops where the next look starts, and remembers when it was last there', () => {
    const looked = line(
      { found: 0, fresh: [], left: 0, since: 'cursor-1' },
      '2026-10-17T10:00:00.000Z',
    )
    const left = line(
      { found: 0, fresh: [], left: 0, since: null, said: 'vps looks with it', on: 'vps' },
      '2026-10-17T11:00:00.000Z',
    )
    const watched = watchedFrom([looked, left], 'checks-app')
    expect(watched.since).toBeNull()
    expect(watched.elsewhereAt).toBe('2026-10-17T11:00:00.000Z')
    const [newest] = watched.looks
    expect(newest?.on).toBe('vps')
    expect(newest && describeLook(newest)).toBe('left to vps: vps looks with it')
    // Back here, a look that worked is where the next starts, and the moment is let go.
    const back = line(
      { found: 0, fresh: [], left: 0, since: 'cursor-2' },
      '2026-10-17T12:00:00.000Z',
    )
    const after = watchedFrom([looked, left, back], 'checks-app')
    expect(after.since).toBe('cursor-2')
    expect(after.elsewhereAt).toBeUndefined()
    expect(after.looks[0]?.on).toBeUndefined()
  })
})
