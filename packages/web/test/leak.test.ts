import { homedir } from 'node:os'
import { deriveState } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { AUTHORED, authored, forbidden, keysIn, NEVER_A_FIELD, stringsIn } from '../src/fields.ts'
import type { Grant } from '../src/reach.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, PRIVATE, reach, task } from './fixtures.ts'

// What the projection leaves out, and what it deliberately does not.
//
// Two claims, and they are different claims:
//
// 1. **Tade's own words carry no path and no credential.** `reason`, `branch`,
//    a check's id, a file name, a warning — Tade wrote all of it, and this is
//    the half a regex can hold, because a field added to a row that drags a
//    path in with it fails here.
// 2. **What a person wrote goes out as they wrote it, and only where it was
//    granted.** It is *not* scrubbed — scrubbing a note is rewording it — so
//    the test for it is the other way round: with the grant, the pasted
//    credential is there; without the grant, nothing of it is anywhere.
//
// Anything stronger than those two is a promise this design cannot keep, and
// a test that implied otherwise would be the most dangerous thing in the
// package (DECISIONS.md §4.11).
//
// **Nothing here keys on a word.** Every assertion looks for a value out of
// `fixtures.ts` — including `PRIVATE.opaque`, which looks like nothing at all
// and is exactly what a list of banned words such as `token` would miss.

const PATHS = [
  PRIVATE.home,
  PRIVATE.root,
  PRIVATE.worktree,
  PRIVATE.transcript,
  PRIVATE.socket,
  PRIVATE.windows,
  '/Users/',
  '/home/',
  'C:\\',
  homedir(),
]

const IDS = [PRIVATE.lane, PRIVATE.run, String(PRIVATE.pid)]

const SECRETS = [PRIVATE.credential, PRIVATE.opaque]

describe('Tade’s own words carry nothing of the machine', () => {
  it('puts no path, no id and no credential in any metadata field', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const guilty: string[] = []
    for (const found of stringsIn(snapshot)) {
      if (authored(found.at)) continue
      for (const needle of [...PATHS, ...IDS, ...SECRETS])
        if (found.words.includes(needle)) guilty.push(`${found.at} holds ${needle}`)
    }
    expect(guilty).toEqual([])
  })

  it('names every string it found, so a new field cannot arrive unclassified', () => {
    // The half that stops the test above passing by finding nothing: if a row
    // stopped being projected, this is what goes red.
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const paths = new Set(stringsIn(snapshot).map((found) => found.at))
    expect(paths.has('tasks[].reason')).toBe(true)
    expect(paths.has('fresh.epoch')).toBe(true)
    expect([...paths].filter((at) => authored(at)).sort()).toEqual([...AUTHORED].sort())
  })

  it('has no field named anything a projection may never hold', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    expect(forbidden(keysIn(snapshot))).toEqual([])
  })

  it('would catch the field a connector is most likely to add', () => {
    // The hook for whatever reads work in from outside later, and the only
    // shape of hook that holds: a name that fails a test, rather than a
    // reserved column nobody earned. Checked against a positive case, because
    // a guard asserted only on clean data proves nothing about the guard.
    expect(forbidden(keysIn({ tasks: [{ id: 'a', verbatim: 'a stranger’s words' }] }))).toEqual([
      'verbatim',
    ])
    expect(forbidden(keysIn({ task: { worktree: '/Users/x' } }))).toEqual(['worktree'])
    expect(forbidden(keysIn({ lane: { pid: 1 } }))).toEqual(['pid'])
    for (const name of Object.keys(NEVER_A_FIELD))
      expect(NEVER_A_FIELD[name]?.length ?? 0, `${name} has no reason beside it`).toBeGreaterThan(
        20,
      )
  })

  it('spells every unknown as null and never as an empty string', () => {
    // `UNRECORDED` is `''` inside the domain, which is right there and wrong
    // on a wire: a client written against two spellings of "nobody said" gets
    // one of them wrong.
    const bare = input({
      reach: reach(EVERY),
      tasks: [task({ branch: '', model: '', effort: '', account: '', title: '', intent: '' })],
      projects: [{ name: 'sentry', title: '' }],
    })
    const snapshot = snapshotOf(bare, NOW)
    const empty = stringsIn(snapshot).filter((found) => found.words === '')
    expect(empty).toEqual([])
    expect(snapshot.tasks[0]?.branch).toBeNull()
    expect(snapshot.tasks[0]?.model).toBeNull()
    expect(snapshot.tasks[0]?.title).toBeNull()
    expect(snapshot.projects[0]?.title).toBeNull()
  })

  it('reads a figure nobody could give as unknown, not as nought', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        tasks: [task({ ahead: null, behind: null, dirty: null, movedAt: null })],
        machineUpSince: null,
      }),
      NOW,
    )
    expect(snapshot.tasks[0]?.ahead).toBeNull()
    expect(snapshot.tasks[0]?.dirty).toBeNull()
    expect(snapshot.tasks[0]?.movedAt).toBeNull()
    expect(snapshot.fresh.machineUpSince).toBeNull()
  })

  it('counts agents and lanes, and names neither', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    expect(snapshot.tasks[0]?.agents).toBe(1)
    expect(snapshot.tasks[0]?.lanes).toBe(2)
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE.lane)
  })
})

describe('a raw tool payload never becomes a reason', () => {
  // The leak this projection exists to close, and it was real: a task blocked
  // on an approval reads `wants approval: <the harness's one-line summary>`,
  // and that summary is the tool call — `Bash: cat …/.ssh/id_rsa`. So
  // DESIGN.md §10.2's "reason is verbatim" and its "no absolute path, ever"
  // contradicted each other in the commonest reason a task is blocked.

  it('is what `deriveState` would have said, so the correction is not imaginary', () => {
    const derived = deriveState({
      now: NOW,
      parked: false,
      git: {
        branch: 'tade/x',
        head: 'a1b2c3d',
        headSubject: 'wip',
        headTime: NOW,
        dirty: [],
        ahead: 0,
        behind: 0,
        baseRef: 'main',
        mergedIntoBase: false,
        upstreamGone: false,
        pr: null,
      },
      agents: [
        {
          source: 'run',
          provider: 'claude-code',
          sessionId: PRIVATE.run,
          alive: true,
          lastActivityAt: NOW,
          turn: 'running',
          pendingPermissions: [PRIVATE.command, 'Read /Users/testperson/.env'],
          consecutiveFailures: 0,
          exitCode: null,
        },
      ],
      tests: 'unknown',
    })
    expect(derived.state).toBe('blocked')
    expect(derived.reason).toContain(PRIVATE.command)
  })

  it('says the same sentence from the tool’s name, and nothing of the call', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const row = snapshot.tasks.find((one) => one.id === 'sentry/blocked')
    expect(row?.reason).toBe('wants approval: Bash (+1 more)')
    expect(row?.approval).toEqual({
      id: 'req_914',
      tool: 'Bash',
      since: '2026-10-08T14:20:00.000Z',
    })
    expect(JSON.stringify(snapshot)).not.toContain('id_rsa')
    expect(JSON.stringify(snapshot)).not.toContain('Authorization')
  })
})

describe('what a person wrote', () => {
  it('goes out as they wrote it, pasted credential and all, where it was granted', () => {
    // Deliberately asserted. Somebody "fixing" the leakage test by scrubbing
    // these fields breaks the one promise they exist to keep, and this is what
    // tells them so.
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const row = snapshot.tasks.find((one) => one.id === 'sentry/pasted')
    expect(row?.intent?.words).toContain(PRIVATE.credential)
    expect(row?.intent?.words).toContain(PRIVATE.opaque)
    expect(row?.title?.words).toContain(PRIVATE.root)
    expect(row?.title?.words).toContain('<script>alert(1)</script>')
  })

  it('is nowhere at all when the device was granted nothing', () => {
    // Names and counts, which is what a paired device gets before anybody
    // decides otherwise. This is the assertion that makes a read scope real.
    const text = JSON.stringify(snapshotOf(input({ reach: reach([]) }), NOW))
    for (const needle of [...SECRETS, ...PATHS])
      expect(text, `granted nothing, yet it carries ${needle}`).not.toContain(needle)
    expect(text).not.toContain('<script>')
    expect(text).toContain('sentry/pasted')
    expect(text).toContain('4 files touched')
  })

  it('is cut on whole characters, so a budget cannot break an emoji', () => {
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), tasks: [task({ title: '🔧'.repeat(10) })] }),
      NOW,
      {},
      {
        projects: 9,
        tasks: 9,
        tasksPerProject: 9,
        queue: 9,
        findings: 9,
        notes: 9,
        plans: 9,
        warnings: 9,
        text: 4,
      },
    )
    expect(snapshot.tasks[0]?.title).toEqual({ words: '🔧🔧🔧🔧', more: true })
  })

  it('is told apart from Tade’s words by a path, not by looking at it', () => {
    expect(authored('tasks[].intent.words')).toBe(true)
    expect(authored('tasks[].reason')).toBe(false)
  })
})

describe('each grant lets through exactly its own content', () => {
  const only = (...granted: Grant[]) => snapshotOf(input({ reach: reach(granted) }), NOW)

  it('gives titles without intent, and intent without titles', () => {
    expect(only('titles').tasks[0]?.title).not.toBeNull()
    expect(only('titles').tasks[0]?.intent).toBeNull()
    expect(only('intent').tasks[0]?.title).toBeNull()
    expect(only('intent').tasks[0]?.intent).not.toBeNull()
  })

  it('gives a review’s state always and its url only with the grant', () => {
    expect(only().tasks[0]?.review).toEqual({ state: 'open', url: null })
    expect(only('reviews').tasks[0]?.review?.url).toContain('pull/412')
  })

  it('gives money only with the grant, and never a nought in its place', () => {
    expect(only().tasks[0]?.spend).toBeNull()
    expect(only('spend').tasks[0]?.spend?.usd).toBe(1.25)
    expect(only('spend').tasks[0]?.spend?.usdOnPlan).toBe(0.4)
  })

  it('gives a sign-in’s name only with the grant', () => {
    expect(only().tasks[0]?.account).toBeNull()
    expect(only('accounts').tasks[0]?.account?.words).toBe('work@example.invalid')
  })

  it('tells you how many notes and findings there are, and not one word of them', () => {
    const bare = only()
    expect(bare.notes).toEqual([])
    expect(bare.pages.notes).toEqual({ total: 2, omitted: 2, next: null, restarted: false })
    expect(bare.findings).toEqual([])
    expect(bare.pages.findings.total).toBe(1)
    const given = only('notes', 'findings')
    expect(given.notes).toHaveLength(2)
    expect(given.findings).toHaveLength(1)
  })
})
