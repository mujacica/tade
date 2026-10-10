import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { inputFrom } from '../scripts/home-input.ts'
import { revise, tick } from '../src/delta.ts'
import { measureDelta, measureOf, sayMeasurement } from '../src/measure.ts'
import { GRANTS } from '../src/reach.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, PRIVATE, reach, task } from './fixtures.ts'

// Measuring a projection without dumping one.
//
// The obvious way to find out how big a projection of a real machine is, is to
// print one and look at it — which puts every task title, every note and
// everything the person pasted into Tade on a terminal and into a scrollback.
// So the measurement is counts, lengths and byte totals, and this is the test
// that says it stayed that way.

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A real home, with something private in every file a projection reads.
 *
 * The task file is written with `yaml.stringify` of a real `TaskFile`, which
 * is what `mkrepo.addTask` and Tade itself do — hand-written lines were kinder
 * than reality in exactly one way that matters here: a real `intent_spoken`
 * written by the orchestrator is a folded multi-line scalar, and a reader
 * tested only against a one-line one is a reader nobody proved. So one of the
 * two tasks below has a multi-line intent and a `start` block with a prompt,
 * which is the shape most task files in a real home actually have.
 */
function realHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tade-web-measure-'))
  homes.push(home)
  taskFile(home, 'sentry', 'away-projection', {
    id: 'sentry/away-projection',
    project: 'sentry',
    intent_spoken: `read ${PRIVATE.root}/src/a.ts and use ${PRIVATE.credential}`,
    created: '2026-10-08T13:52:31.585Z',
    base: 'c220aa182aaf1074515d6b72c39cbf467b48bb48',
    parked: false,
    lanes: ['sentry/away-projection/agent'],
    title: `fix the thing in ${PRIVATE.worktree}`,
    workspace: 'checkout',
    effort: 'remote-software-factory',
    by: 'orchestrator',
    done: 'said',
    account: `${PRIVATE.opaque}@example.invalid`,
  })
  taskFile(home, 'sentry', 'folded', {
    id: 'sentry/folded',
    project: 'sentry',
    // What the orchestrator actually writes: several sentences, which `yaml`
    // folds, and which a reader has to put back together.
    intent_spoken: [
      'at the end we should be able to web access tade',
      '',
      `and the key is ${PRIVATE.opaque} — read ${PRIVATE.windows}\\notes.txt`,
    ].join('\n'),
    created: '2026-10-08T13:55:00.000Z',
    parked: true,
    start: {
      after: [{ task: 'sentry/away-projection', why: 'the contracts come first' }],
      prompt: `build it, reading ${PRIVATE.root}/DESIGN.md first`,
      touches: ['packages/web'],
      model: { provider: 'anthropic', id: 'claude-opus-5' },
    },
  })
  writeFileSync(
    join(home, 'memory.jsonl'),
    `${JSON.stringify({
      text: `the key is ${PRIVATE.opaque}`,
      scope: 'sentry',
      by: 'voice',
      at: '2026-10-08T12:00:00.000Z',
    })}\n`,
  )
  return home
}

/** One task file, written the way Tade writes one. */
function taskFile(
  home: string,
  project: string,
  name: string,
  file: Record<string, unknown>,
): void {
  const dir = join(home, 'projects', project, 'tasks', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task.yaml'), stringify(file))
}

describe('the report', () => {
  it('says what a projection weighs and how much of it is unknown', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const found = measureOf(snapshot)
    expect(found.bytes).toBeGreaterThan(0)
    expect(found.collections.map((one) => one.collection)).toEqual([
      'projects',
      'tasks',
      'queue',
      'findings',
      'notes',
      'plans',
      'chat',
    ])
    expect(found.collections.find((one) => one.collection === 'tasks')?.rows).toBe(4)
    expect(found.nulls).toBeGreaterThan(0)
    expect(found.strings.authored).toBeGreaterThan(0)
    expect(found.strings.metadata).toBeGreaterThan(found.strings.authored)
    expect(found.reads).toEqual([...GRANTS])
    expect(found.warnings).toBe(5)
  })

  it('counts a collection the device may not read as all of it omitted', () => {
    const found = measureOf(snapshotOf(input({ reach: reach([]) }), NOW))
    const notes = found.collections.find((one) => one.collection === 'notes')
    expect(notes).toMatchObject({ rows: 0, total: 2, omitted: 2 })
    expect(found.strings.authored).toBe(0)
  })

  it('tells a tick from a beat that moved something', () => {
    const one = input({ reach: reach(EVERY) })
    const made = revise(null, one, NOW)
    expect(measureDelta(tick(made.snapshot, NOW + 2_000)).timeOnly).toBe(true)
    const moved = revise(made.snapshot, { ...one, notes: [] }, NOW + 2_000)
    expect(moved.kind === 'changed' && measureDelta(moved.delta).timeOnly).toBe(false)
  })

  it('counts the rows a delta set and the rows it deleted', () => {
    const one = input({ reach: reach(EVERY) })
    const made = revise(null, one, NOW)
    const fewer = revise(
      made.snapshot,
      { ...one, tasks: one.tasks.filter((found) => found.project === 'tade') },
      NOW + 2_000,
    )
    expect(fewer.kind).toBe('changed')
    if (fewer.kind !== 'changed') return
    const found = measureDelta(fewer.delta)
    expect(found.del).toBe(3)
    expect(found.timeOnly).toBe(false)
    const said = sayMeasurement(measureOf(fewer.snapshot), [found])
    expect(said).toContain('rows touched')
    expect(said).toContain('1 moved something')
  })

  it('does not call a frame whose counts moved a tick', () => {
    // A withheld collection growing moves a `total` and no row at all, which
    // is a frame that carried more than the clock.
    const one = input({ reach: reach([]) })
    const made = revise(null, one, NOW)
    const grown = revise(
      made.snapshot,
      { ...one, notes: [...one.notes, ...one.notes] },
      NOW + 2_000,
    )
    expect(grown.kind).toBe('changed')
    if (grown.kind !== 'changed') return
    const found = measureDelta(grown.delta)
    expect(found.set).toBe(0)
    expect(found.del).toBe(0)
    expect(found.timeOnly).toBe(false)
  })

  it('prints not one word of what it measured', () => {
    // Built to be caught: every private string in the fixture is in a field
    // the projection carries, and the whole report is searched for each.
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        tasks: [task({ title: PRIVATE.root, intent: PRIVATE.opaque })],
      }),
      NOW,
    )
    const said = sayMeasurement(measureOf(snapshot), [measureDelta(tick(snapshot, NOW))])
    for (const value of Object.values(PRIVATE))
      expect(said, `the report says ${value}`).not.toContain(String(value))
    expect(said).not.toContain('sentry/away-projection')
    expect(said).toContain('collection')
  })
})

describe('measured from a real home', () => {
  it('reads the task files and the notes that are actually there', () => {
    const home = realHome()
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: GRANTS }, NOW)
    expect(one.projects.map((project) => project.name)).toEqual(['sentry'])
    expect(one.tasks.map((found) => found.id).sort()).toEqual([
      'sentry/away-projection',
      'sentry/folded',
    ])
    expect(one.tasks[0]?.intent).toContain(PRIVATE.credential)
    expect(one.tasks[0]?.lanes).toBe(1)
    expect(one.notes).toHaveLength(1)
    expect(one.machineUpSince === null || one.machineUpSince > 0).toBe(true)
  })

  it('puts a folded multi-line intent back together, which is the shape most have', () => {
    // `yaml` writes a several-sentence `intent_spoken` as a folded `>-`
    // scalar, wrapped across lines mid-sentence. A reader proved only against
    // a one-line intent is a reader nobody proved.
    const home = realHome()
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: GRANTS }, NOW)
    const folded = one.tasks.find((found) => found.id === 'sentry/folded')
    expect(folded?.intent).toContain('web access tade')
    expect(folded?.intent).toContain(PRIVATE.opaque)
    expect(folded?.intent).toContain(PRIVATE.windows)
  })

  it('reads the told facts a file can answer, and leaves the rest unknown', () => {
    const home = realHome()
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: GRANTS }, NOW)
    const folded = one.tasks.find((found) => found.id === 'sentry/folded')
    expect(folded?.state).toBe('parked')
    expect(folded?.reason).toEqual({ kind: 'clause', said: 'parked by you' })
    expect(folded?.model).toBe('claude-opus-5')
    expect(folded?.movedAt).toBeNull()
    expect(one.queue.map((item) => item.task)).toEqual(['sentry/away-projection'])
  })

  it('says it looked at files alone rather than implying it looked at git', () => {
    const home = realHome()
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: [] }, NOW)
    expect(one.warnings[0]).toContain('files alone')
    expect(one.tasks[0]?.checks.state).toBe('unknown')
    expect(one.tasks[0]?.ahead).toBeNull()
  })

  it('skips a task file it cannot parse instead of throwing over the home', () => {
    const home = realHome()
    const broken = join(home, 'projects', 'sentry', 'tasks', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'task.yaml'), 'this: [is not: a task file\n')
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: [] }, NOW)
    expect(one.tasks.map((found) => found.id).sort()).toEqual([
      'sentry/away-projection',
      'sentry/folded',
    ])
  })

  it('measures it, and says nothing of what is in it', () => {
    const home = realHome()
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: GRANTS }, NOW)
    const made = revise(null, one, NOW)
    const said = sayMeasurement(measureOf(made.snapshot), [
      measureDelta(tick(made.snapshot, NOW + 2_000)),
    ])
    for (const value of Object.values(PRIVATE))
      expect(said, `the report says ${value}`).not.toContain(String(value))
    expect(said).toMatch(/tasks\s+2/)
  })

  it('answers an empty home with an empty projection rather than a throw', () => {
    const home = mkdtempSync(join(tmpdir(), 'tade-web-empty-'))
    homes.push(home)
    const one = inputFrom(home, { device: 'm', projects: { kind: 'every' }, granted: [] }, NOW)
    expect(one.projects).toEqual([])
    expect(one.notes).toEqual([])
    expect(measureOf(revise(null, one, NOW).snapshot).collections[1]?.rows).toBe(0)
  })
})
