import { mkdirSync, writeFileSync } from 'node:fs'
import { ConfigSchema } from '@tade/core'
import { collectStatus } from '@tade/status'
import { SnapshotSchema, snapshotOf } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { awayCollections, nothingKnown } from '../src/away.ts'

// The projection over what `collectStatus` really says, rather than over a
// fixture somebody wrote.
//
// **Why this file exists at all.** `away.test.ts` beside it asks the same
// question exhaustively against a hand-written `Workspace`, which is the right
// way to ask most of it — but a hand-written one is written by somebody who
// knows what the answer should be, and the field this is about is the one
// nothing in this repository composes: `Workspace.warnings`. `collectStatus`
// writes `<project>: <its root>: <what git said>` when a checkout will not
// answer, and a fixture whose warnings happen to be a tidy sentence is the
// leakage test passing while the claim is false. DECISIONS.md §4.11 names that
// failure; this is the test that would have caught it.
//
// Real git repositories and a real `collectStatus`, for the house reason: a
// fixture must not be kinder than reality, and nothing here mocks git.

/** Anything that names somewhere on this machine rather than in a repository. */
function machinePaths(words: string): string[] {
  return (words.match(/\S+/g) ?? []).filter(
    (word) => /^~[/\\]/.test(word) || /^[A-Za-z]:[\\/]/.test(word) || /^\/.*\//.test(word),
  )
}

async function worldFor(config: Parameters<typeof ConfigSchema.parse>[0], home: string) {
  return collectStatus({
    config: ConfigSchema.parse(config),
    now: Date.parse('2026-10-08T14:30:00.000Z'),
    home,
    tadeHome: home,
    pr: false,
    processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
  })
}

function project(world: Awaited<ReturnType<typeof worldFor>>) {
  return awayCollections({
    world,
    titles: {},
    extras: new Map(world.projects.flatMap((one) => one.tasks.map((t) => [t.id, nothingKnown()]))),
    pending: new Map(),
    queued: [],
    queueFacts: { tasks: new Map(), finished: new Map(), events: [], now: 0 },
    order: [],
    notes: [],
    plans: [],
    machineUpSince: null,
    spendSince: null,
  })
}

describe('what a real status says, as a phone would read it', () => {
  it('carries no machine path in a warning, however status worded it', async () => {
    // A project configured at somewhere that is not a git repository, which is
    // what a moved or deleted checkout looks like and is the commonest way a
    // warning gets a path in it.
    const home = tmp('tade-away-home-')
    const gone = tmp('tade-away-gone-')
    mkdirSync(gone, { recursive: true })
    writeFileSync(`${gone}/README.md`, 'moved away\n')

    const world = await worldFor({ projects: { shop: { root: gone } } }, home)
    // The reproduction: status really does name the checkout, so this test is
    // about something that happens rather than about something imagined.
    expect(world.warnings.join('\n')).toContain(gone)

    const snapshot = snapshotOf(
      {
        ...project(world),
        reach: { device: 'd', projects: { kind: 'every' }, granted: [] },
        lifetime: { epoch: 'e', rev: 0, openedAt: 0 },
        // Not part of the world: the window lays it over (`talkFor`), and a
        // test about what the world's own folds carry hands over none.
        talk: null,
      },
      Date.parse('2026-10-08T14:30:00.000Z'),
    )
    expect(SnapshotSchema.parse(snapshot)).toBeTruthy()
    expect(snapshot.fresh.warnings.length).toBeGreaterThan(0)
    for (const said of snapshot.fresh.warnings) expect(machinePaths(said)).toEqual([])
    expect(snapshot.fresh.warnings.join('\n')).not.toContain(gone)
    expect(snapshot.fresh.warnings.join('\n')).not.toContain(home)
  })

  it('still says which project it was, because that is the half a phone can use', async () => {
    const home = tmp('tade-away-home-')
    const gone = tmp('tade-away-gone-')
    mkdirSync(gone, { recursive: true })

    const world = await worldFor({ projects: { shop: { root: gone } } }, home)
    const snapshot = snapshotOf(
      {
        ...project(world),
        reach: { device: 'd', projects: { kind: 'every' }, granted: [] },
        lifetime: { epoch: 'e', rev: 0, openedAt: 0 },
        // Not part of the world: the window lays it over (`talkFor`), and a
        // test about what the world's own folds carry hands over none.
        talk: null,
      },
      Date.parse('2026-10-08T14:30:00.000Z'),
    )
    // Taking the path out is not taking the sentence out: *shop could not be
    // read* is the whole of what somebody away from the machine can act on,
    // and a warning cut to nothing would be worse than none at all.
    expect(snapshot.fresh.warnings.join('\n')).toContain('shop')
  })

  it('says nothing at all when every project reads cleanly', async () => {
    // The other half, so the test above cannot pass by warning about
    // everything: a real repository that status can read produces no warning
    // with a path in it, and the page draws no bar.
    const repo = mkrepo()
    const world = await worldFor({ projects: { shop: { root: repo.root } } }, repo.home)
    const snapshot = snapshotOf(
      {
        ...project(world),
        reach: { device: 'd', projects: { kind: 'every' }, granted: [] },
        lifetime: { epoch: 'e', rev: 0, openedAt: 0 },
        // Not part of the world: the window lays it over (`talkFor`), and a
        // test about what the world's own folds carry hands over none.
        talk: null,
      },
      Date.parse('2026-10-08T14:30:00.000Z'),
    )
    for (const said of snapshot.fresh.warnings) expect(machinePaths(said)).toEqual([])
  })
})
