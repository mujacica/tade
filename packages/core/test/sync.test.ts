import { describe, expect, it } from 'vitest'
import {
  ConfigSchema,
  type Contains,
  mergeProposal,
  mergeSlugStem,
  mirrorMachine,
  parseConfig,
  type SyncFacts,
  syncedNews,
  syncFor,
  syncToldSays,
  syncVerdict,
  targetOf,
} from '../src/index.ts'

// Keeping a branch in step (`sync.ts`): the target among the sources, and the
// six rules over one look — each refusal naming its reason, and every path in
// the way named.

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

/** A history: A, then B on it, then C on B; D on A beside them. */
const contains: Contains = (older, newer) => {
  const parents: Record<string, string[]> = { [A]: [], [B]: [A], [C]: [B], [D]: [A] }
  const seen = new Set<string>()
  const walk = (at: string): boolean => {
    if (at === older) return true
    if (seen.has(at)) return false
    seen.add(at)
    return (parents[at] ?? []).some(walk)
  }
  return walk(newer)
}

const facts = (over: Partial<SyncFacts> = {}): SyncFacts => ({
  project: 'app',
  branch: 'main',
  at: { kind: 'checkout', dir: '/src/app' },
  head: A,
  target: { kind: 'one', sha: C, from: ['vps'] },
  forward: true,
  ahead: 0,
  behind: 2,
  incoming: [
    { path: 'src/one.ts', added: false },
    { path: 'src/new.ts', added: true },
  ],
  dirty: [],
  staged: [],
  inTheWay: [],
  committing: false,
  ...over,
})

describe('the target among the sources', () => {
  it('is the one that has every other source’s commits', () => {
    expect(
      targetOf(
        A,
        [
          { from: 'origin', sha: B },
          { from: 'vps', sha: C },
        ],
        contains,
      ),
    ).toEqual({ kind: 'one', sha: C, from: ['vps'] })
  })

  it('names every source on that commit', () => {
    expect(
      targetOf(
        A,
        [
          { from: 'origin', sha: C },
          { from: 'vps', sha: C },
        ],
        contains,
      ),
    ).toEqual({ kind: 'one', sha: C, from: ['origin', 'vps'] })
  })

  it('is none where every source is already in this branch, or there is no source', () => {
    expect(targetOf(C, [{ from: 'vps', sha: B }], contains)).toMatchObject({
      kind: 'none',
      why: 'it has everything vps has',
    })
    expect(targetOf(C, [], contains).kind).toBe('none')
  })

  it('is no target where two sources have parted, and says which', () => {
    expect(
      targetOf(
        A,
        [
          { from: 'origin', sha: C },
          { from: 'vps', sha: D },
        ],
        contains,
      ),
    ).toEqual({ kind: 'apart', a: { from: 'origin', sha: C }, b: { from: 'vps', sha: D } })
  })
})

describe('the rules', () => {
  it('moves a clean fast-forward in the checkout', () => {
    expect(syncVerdict(facts(), 'ff')).toEqual({
      kind: 'move',
      target: C,
      from: ['vps'],
      behind: 2,
      byRef: false,
    })
  })

  it('moves only the ref where nothing has the branch checked out, whatever is dirty', () => {
    expect(
      syncVerdict(facts({ at: { kind: 'nowhere' }, dirty: ['src/one.ts'] }), 'ff'),
    ).toMatchObject({ kind: 'move', byRef: true })
  })

  it('refuses, naming the path, where a file the move changes is uncommitted here', () => {
    const verdict = syncVerdict(facts({ dirty: ['src/one.ts', 'notes.txt'] }), 'ff')
    expect(verdict).toMatchObject({ kind: 'refused', paths: ['src/one.ts'] })
    expect(verdict.kind === 'refused' && verdict.why).toContain('src/one.ts')
    // A dirty file the move does not touch is nobody's business.
    expect(syncVerdict(facts({ dirty: ['notes.txt'] }), 'ff').kind).toBe('move')
  })

  it('refuses where a file the move adds is already on disk, untracked or ignored', () => {
    const verdict = syncVerdict(facts({ inTheWay: ['src/new.ts'] }), 'ff')
    expect(verdict).toMatchObject({ kind: 'refused', paths: ['src/new.ts'] })
  })

  it('names every path in the way, up to twenty, and counts the rest', () => {
    const many = Array.from({ length: 23 }, (_, i) => `f${i}.ts`)
    const verdict = syncVerdict(
      facts({ incoming: many.map((path) => ({ path, added: false })), dirty: many }),
      'ff',
    )
    expect(verdict.kind === 'refused' && verdict.paths).toHaveLength(23)
    expect(verdict.kind === 'refused' && verdict.why).toContain('f19.ts and 3 more')
  })

  it('waits while somebody is mid-commit: the index lock, or anything staged', () => {
    expect(syncVerdict(facts({ committing: true }), 'ff')).toMatchObject({ kind: 'wait' })
    const staged = syncVerdict(facts({ staged: ['other.ts'], dirty: ['other.ts'] }), 'ff')
    expect(staged.kind).toBe('wait')
    expect(staged.kind === 'wait' && staged.why).toContain('other.ts')
  })

  it('proposes rather than merges where the branch here has commits the target lacks', () => {
    expect(syncVerdict(facts({ forward: false, ahead: 1, behind: 2 }), 'ff')).toMatchObject({
      kind: 'diverged',
      target: C,
      ahead: 1,
      behind: 2,
    })
  })

  it('holds where the sources parted, and moves nothing', () => {
    const verdict = syncVerdict(
      facts({
        target: { kind: 'apart', a: { from: 'origin', sha: C }, b: { from: 'vps', sha: D } },
      }),
      'ff',
    )
    expect(verdict.kind).toBe('apart')
    expect(verdict.kind === 'apart' && verdict.why).toContain("origin's main and vps's main")
  })

  it('leaves a branch checked out in an agent’s worktree to that agent', () => {
    expect(
      syncVerdict(facts({ at: { kind: 'worktree', dir: '/w', task: 'app/fix' } }), 'ff'),
    ).toMatchObject({ kind: 'still', why: expect.stringContaining("app/fix's worktree") })
  })

  it('asks rather than moves where the project says ask, once every other rule has passed', () => {
    expect(syncVerdict(facts(), 'ask')).toMatchObject({ kind: 'ask', target: C })
    expect(syncVerdict(facts({ dirty: ['src/one.ts'] }), 'ask').kind).toBe('refused')
    expect(syncVerdict(facts(), 'off')).toMatchObject({ kind: 'still' })
  })
})

describe('the setting', () => {
  it('is ff unless the project says otherwise, and refuses anything else', () => {
    const config = ConfigSchema.parse({ projects: { app: { root: '/src/app' } } })
    expect(syncFor(config.projects, 'app')).toBe('ff')
    const asked = parseConfig('projects:\n  app:\n    root: /src/app\n    sync: ask\n')
    expect(asked.ok && syncFor(asked.config.projects, 'app')).toBe('ask')
    const wrong = parseConfig('projects:\n  app:\n    root: /src/app\n    sync: always\n')
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.issues[0]?.path).toBe('projects.app.sync')
  })
})

describe('what is said', () => {
  it('tells an agent HEAD moved, from what to what, and which files', () => {
    const told = syncToldSays({
      branch: 'main',
      from: ['vps'],
      was: A,
      now: C,
      files: ['src/one.ts', 'src/new.ts'],
    })
    expect(told).toContain(`HEAD moved from ${A.slice(0, 7)} to ${C.slice(0, 7)}`)
    expect(told).toContain("vps's main")
    expect(told).toContain('src/one.ts, src/new.ts')
    expect(told).toContain('Read a file again before you edit it')
  })

  it('tells the orchestrator who was told', () => {
    expect(
      syncedNews({
        project: 'app',
        branch: 'main',
        from: ['origin', 'vps'],
        was: A,
        now: C,
        files: 2,
        told: ['app/fix'],
        byRef: false,
      }),
    ).toBe(
      `app's main was fast-forwarded from ${A.slice(0, 7)} to ${C.slice(0, 7)}, to origin and vps's main (2 files changed); app/fix was told to read again before editing.`,
    )
  })

  it('names a merge proposal by its source, branch and target, in a usable task name', () => {
    const made = mergeProposal({
      project: 'app',
      branch: 'release/1.0',
      from: 'vps',
      head: A,
      target: C,
      ahead: 1,
      behind: 2,
    })
    expect(made.slug).toBe(`merge-vps-release-1-0-${C.slice(0, 7)}`)
    expect(made.slug.startsWith(`${mergeSlugStem('vps', 'release/1.0')}-`)).toBe(true)
    expect(made.prompt).toContain('Tade only ever fast-forwards')
    expect(made.context).toContain(`git merge ${C}`)
  })

  it('makes a namespace of a host name', () => {
    expect(mirrorMachine('Amirs-MacBook-Pro.local')).toBe('amirs-macbook-pro-local')
    expect(mirrorMachine('mac')).toBe('mac')
    expect(mirrorMachine('origin')).toBe('machine')
    expect(mirrorMachine('___')).toBe('machine')
  })
})
