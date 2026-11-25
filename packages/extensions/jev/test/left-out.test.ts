import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProgram } from '@tade/core'
import type { HostOptions } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { namesIn } from '../src/changes.ts'
import { readReviews } from '../src/reviews.ts'
import { host, NOW, typesafe } from './harness.ts'

// A change with a generated city in it, read in part and said so.
//
// The nightly agent's change carried vrolta's generated city, the night's
// requirement records and a few binaries beside its real fixes, so one
// combined `git show` of it was more than the 64 MB the program runner keeps —
// and the review watch said it could not look, about the whole change, every
// ten minutes. What is held here is the shape of the fix: the change is listed
// first, what no question is about is left out by name, each file left is read
// on its own with a cap on what git may print, and a change git still cannot
// read is said once, as a notice, until it moves.

const asked = { caller: { kind: 'orchestrator' } as const }

/** The real fix, small enough to read whole. */
const FIX = 'export function nightlyWindow(at: number): boolean {\n  return at >= 22\n}\n'

/** What the night carried beside it, each something no question is about. */
function night(): Record<string, string> {
  // A row of the city, repeated: compressible, so the fixture stays quick to
  // commit, and far bigger than anything the reading may fetch.
  const row = '{"block":"CITY-ROW","height":12,"tiles":[1,2,3,4,5,6,7,8]},\n'
  return {
    '.gitattributes': 'city/** linguist-generated\n*.bake -diff\n',
    'src/nightly.ts': FIX,
    // 3 MB the repository itself marks generated.
    'city/map.json': `[\n${row.repeat(50_000)}]\n`,
    // 1.5 MB nobody marked: over the size a file is read at, by name.
    'records/night.json': `[\n${'{"requirement":"RECORD-ROW","met":true},\n'.repeat(37_000)}]\n`,
    // Under that size, but a patch over the size one file's patch is read at.
    'data/table.csv': 'TABLE-ROW,1,2,3\n'.repeat(20_000),
    // Bytes git calls binary, and a file the attributes say is never diffed.
    'assets/sprite.bin': `\0\x01\x02SPRITE-BYTES${'\0'.repeat(64)}`,
    'light.bake': 'BAKE-ROW\n'.repeat(10),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\nLOCK-ROW: 1\n',
  }
}

/** The host's own way of running a program, keeping the biggest thing git printed. */
function measured(): { exec: HostOptions['exec']; biggest: () => number } {
  let biggest = 0
  return {
    exec: async (command, args, options) => {
      const ran = await runProgram(command, args, {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        timeoutMs: options?.timeoutMs ?? 10_000,
        ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      })
      biggest = Math.max(biggest, Buffer.byteLength(ran.stdout))
      return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr }
    },
    biggest: () => biggest,
  }
}

/** A checkout everybody shares, with one agent's signed commit in it: the nightly agent's shape. */
function sharedNight() {
  const repo = mkrepo()
  repo.commit('start', { 'README.md': 'city\n' })
  const base = repo.head()
  const dir = join(repo.home, 'projects', 'city', 'tasks', 'nightly')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'task.yaml'),
    [
      'id: city/nightly',
      'project: city',
      'intent_spoken: tonight’s nightly, and its fixes',
      'created: 2026-09-11T09:14:22Z',
      `base: ${base}`,
      'workspace: checkout',
      '',
    ].join('\n'),
  )
  repo.write(night())
  repo.git('add', '-A')
  repo.git('commit', '-q', '-m', 'the night\n\nTade-Task: city/nightly')
  return repo
}

describe('a change with generated files in it', () => {
  it('lists the paths once each, in the order git gave them', () => {
    // `--name-status -z`: a status, then a path, for every commit in turn.
    expect(namesIn('A\0src/a.ts\0M\0b.json\0M\0src/a.ts\0D\0gone.txt\0')).toEqual([
      'src/a.ts',
      'b.json',
      'gone.txt',
    ])
    expect(namesIn('')).toEqual([])
  })

  it('reads the real change, leaves out the rest by name, and never asks git for all of it', async () => {
    const repo = sharedNight()
    const seen: unknown[] = []
    const git = measured()
    const loaded = await host({
      home: repo.home,
      projects: { city: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({ test_missing: 0.9 }, seen),
      now: Date.now,
      exec: git.exec,
    })
    const look = await loaded.look('jev.review', {
      project: 'city',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    // It looked, and found what it found about the fix.
    expect(look.found.map((finding) => finding.key)).toEqual(['city/nightly:test_missing'])
    const detail = look.found[0]?.detail ?? ''
    // And the finding says what was left out, by name and why, to the agent
    // that has to account for it.
    expect(detail).toContain('Left out by name and never read —')
    expect(detail).toContain('too big to read (2): records/night.json, data/table.csv')
    expect(detail).toContain('Too big is a file over 1 MB, or a patch over 200 KB.')
    expect(detail).toContain('marked linguist-generated (1): city/map.json')
    expect(detail).toContain('marked -diff (1): light.bake')
    expect(detail).toContain('binary (1): assets/sprite.bin')
    expect(detail).toContain('lockfiles (1): pnpm-lock.yaml')

    // What reached the judge is the fix and the attributes, and none of the night.
    const sent = JSON.stringify(seen)
    expect(sent).toContain('nightlyWindow')
    for (const bulk of ['CITY-ROW', 'RECORD-ROW', 'TABLE-ROW', 'SPRITE-BYTES', 'BAKE-ROW']) {
      expect(sent).not.toContain(bulk)
    }
    // And git was never let print more than one file's cap, where one
    // `git show` of everything was 6 MB here and 64 MB on the machine it broke.
    expect(git.biggest()).toBeLessThan(210_000)

    // The record says the same, beside every answer.
    const [review] = readReviews(repo.home)
    expect(review?.files).toBe(2)
    expect(review?.part).toContain('marked linguist-generated (1): city/map.json')
  })

  it('reads a worktree’s range the same way', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('nightly', { project: 'city', intent: 'tonight’s nightly' })
    repo.commit('the night', night(), worktree)
    const seen: unknown[] = []
    const loaded = await host({
      home: repo.home,
      projects: { city: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}, seen),
    })
    const answer = await loaded.call('jev_review', { project: 'city', task: 'city/nightly' }, asked)
    expect(answer.text).toContain('Left out by name and never read —')
    expect(answer.text).toContain('marked linguist-generated (1): city/map.json')
    expect(answer.said).toMatch(/^Read part of city\/nightly/)
    expect(JSON.stringify(seen)).not.toContain('CITY-ROW')
  })

  it('says a change with nothing a question could be about once, by name, rather than nothing', async () => {
    const repo = mkrepo()
    // The attributes are the project's before the task starts, so what the
    // task changed is only the city.
    repo.commit('attributes', { '.gitattributes': 'city/** linguist-generated\n' })
    const worktree = repo.addTask('rebuild', { project: 'city', intent: 'rebuild the city' })
    const head = repo.commit('rebuild', { 'city/map.json': '{"block":1}\n' }, worktree)
    const seen: unknown[] = []
    const loaded = await host({
      home: repo.home,
      projects: { city: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}, seen),
      now: Date.now,
    })
    const look = await loaded.look('jev.review', {
      project: 'city',
      input: { settle: '0m' },
      since: null,
      turnedOn: new Date(NOW - 60_000).toISOString(),
    })
    expect(look.found).toEqual([])
    expect(seen).toEqual([])
    expect(look.said).toBe(
      `city/rebuild at ${head.slice(0, 8)}: nothing in it a question could be about. Left out by name and never read — marked linguist-generated (1): city/map.json.`,
    )
    expect(JSON.parse(look.since ?? '{}')).toEqual({ 'city/rebuild': head })
  })
})

describe('a change git cannot read at all', () => {
  it('is said once, as a notice and not as a look that could not look, until it moves', async () => {
    const repo = mkrepo()
    const worktree = repo.addTask('regenerate', { project: 'city', intent: 'regenerate' })
    const head = repo.commit('regenerate', { 'src/city.ts': 'export const city = 1\n' }, worktree)
    // Its tree gone from the object store: git can name the commit and cannot
    // say what is in it, which is the change's own trouble and not the look's.
    const tree = repo.git('rev-parse', `${head}^{tree}`).trim()
    const object = join(repo.root, '.git', 'objects', tree.slice(0, 2), tree.slice(2))
    const kept = readFileSync(object)
    rmSync(object)
    const loaded = await host({
      home: repo.home,
      projects: { city: { root: repo.root } },
      env: { TYPESAFE_API_KEY: 'k' },
      fetch: typesafe({}),
      now: Date.now,
    })
    const look = (since: string | null) =>
      loaded.look('jev.review', {
        project: 'city',
        input: { settle: '0m' },
        since,
        turnedOn: new Date(NOW - 60_000).toISOString(),
      })

    // Not thrown: thrown is a ✗ in the transcript, and that was every ten minutes.
    const first = await look(null)
    expect(first.found).toEqual([])
    expect(first.said).toMatch(
      new RegExp(`^city/regenerate at ${head.slice(0, 8)}: it could not be read: git diff: `),
    )
    // Keyed by its head: the cursor is past it, so the next look has nothing
    // to say about it at all.
    expect(JSON.parse(first.since ?? '{}')).toEqual({ 'city/regenerate': head })
    const second = await look(first.since)
    expect(second.said).toBeNull()
    expect(second.since).toBe(first.since)

    // Once it moves it is read again, and read.
    writeFileSync(object, kept)
    const moved = repo.commit('fixed', { 'fixed.ts': 'export const fixed = 1\n' }, worktree)
    const third = await look(second.since)
    expect(third.said).toBeNull()
    expect(JSON.parse(third.since ?? '{}')).toEqual({ 'city/regenerate': moved })
    expect(readReviews(repo.home)).toHaveLength(1)
  })
})
