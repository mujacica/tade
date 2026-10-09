import { describe, expect, it } from 'vitest'
import { BUDGET, type Budget, pageOf, textOf } from '../src/page.ts'
import { reasonOf, snapshotOf, wantsYou } from '../src/snapshot.ts'
import { EVERY, finding, input, NOW, note, plan, project, reach, task } from './fixtures.ts'

const budget = (over: Partial<Budget> = {}): Budget => ({ ...BUDGET, ...over })

describe('the projection', () => {
  it('is of the moment it was handed, and of the server’s own lifetime', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    expect(snapshot.fresh.at).toBe('2026-10-08T14:30:00.000Z')
    expect(snapshot.fresh.epoch).toBe('7f3a9c21-0000-4000-8000-000000000000')
    expect(snapshot.fresh.rev).toBe(12)
    // **Status's own sentences, with anything shaped like a path taken out
    // of them.** A warning is the one metadata field this package does not
    // write — `collectStatus` composes `<project>: <its root>: <what git
    // said>` — so the projection's claim that it adds no path of its own is
    // kept here rather than inherited (`withoutPaths`, `fields.ts`). A
    // repository-relative name is not a path and stays.
    expect(snapshot.fresh.warnings).toEqual([
      'tmux is not installed, so no lane could be looked at',
      'sentry: …: fatal: not a git repository (or any of the parent directories): .git',
      '…: could not compare with main',
      'sentry/gone: no worktree of its own any more; its files are in …',
      '…: could not be read',
    ])
  })

  it('says how many more could not be read rather than carrying all of them', () => {
    // The freshness rides on every frame, so this is the one collection whose
    // budget is about what a connected phone pays for ever rather than about
    // what fits on a screen.
    const many = Array.from({ length: 25 }, (_, n) => `project-${n}: could not be read`)
    const snapshot = snapshotOf(input({ reach: reach(EVERY), warnings: many }), NOW)
    expect(snapshot.fresh.warnings).toHaveLength(10)
    expect(snapshot.fresh.warnings[8]).toBe('project-8: could not be read')
    expect(snapshot.fresh.warnings.at(-1)).toBe('and 16 more things could not be read')
  })

  it('says which device it is for and what that device may read', () => {
    const snapshot = snapshotOf(input({ reach: reach(['notes', 'spend']) }), NOW)
    expect(snapshot.you).toEqual({ device: 'dev_7f3a9c21', reads: ['notes', 'spend'] })
  })

  it('drops a grant nothing here understands rather than drawing the word', () => {
    const odd = reach(['notes', 'everything' as never])
    expect(snapshotOf(input({ reach: odd }), NOW).you.reads).toEqual(['notes'])
  })

  it('carries `deriveState`’s clause as it was written', () => {
    expect(reasonOf({ kind: 'clause', said: 'turn ended with 3 uncommitted files' })).toBe(
      'turn ended with 3 uncommitted files',
    )
  })

  it('writes the approval clause the way `deriveState` writes it', () => {
    expect(reasonOf({ kind: 'approval', tool: 'Bash', also: 0 })).toBe('wants approval: Bash')
    expect(reasonOf({ kind: 'approval', tool: 'Write', also: 2 })).toBe(
      'wants approval: Write (+2 more)',
    )
  })

  it('derives one flag and reads the rest', () => {
    expect(['blocked', 'failed', 'review'].map(wantsYou as never)).toEqual([true, true, true])
    expect(['working', 'queued', 'merged', 'parked'].map(wantsYou as never)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  it('splits a task’s name out of its id, so a phone need not', () => {
    const snapshot = snapshotOf(input({ reach: reach() }), NOW)
    expect(snapshot.tasks.map((one) => one.name)).toContain('away-projection')
  })

  it('sorts every collection by its own stable id', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    expect(snapshot.tasks.map((one) => one.id)).toEqual([
      'sentry/away-projection',
      'sentry/blocked',
      'sentry/pasted',
      'tade/window',
    ])
    expect(snapshot.projects.map((one) => one.name)).toEqual(['sentry', 'tade'])
  })

  it('counts each project’s tasks, and how many of them are here', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    const sentry = snapshot.projects.find((one) => one.name === 'sentry')
    expect(sentry?.counts).toEqual({ tasks: 3, shown: 3, wantsYou: 1, working: 2, queued: 0 })
  })

  it('turns a scheduled queue hold into a moment, not a duration', () => {
    const at = Date.parse('2026-10-09T09:00:00.000Z')
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        queue: [
          {
            task: 'sentry/later',
            project: 'sentry',
            state: { kind: 'scheduled', at },
            order: 3,
            waitsOn: [],
          },
        ],
      }),
      NOW,
    )
    expect(snapshot.queue[0]?.state).toEqual({ kind: 'scheduled', at: '2026-10-09T09:00:00.000Z' })
    expect(snapshot.queue[0]?.order).toBe(3)
  })

  it('counts the files a collision is about and never names them', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        queue: [
          {
            task: 'sentry/later',
            project: 'sentry',
            state: {
              kind: 'held',
              on: null,
              because: 'work going on now has changed 3 of the files it is planned to change',
              changed: 3,
              by: ['sentry/away-projection'],
            },
            order: null,
            waitsOn: [],
          },
        ],
      }),
      NOW,
    )
    const state = snapshot.queue[0]?.state
    expect(state?.kind).toBe('held')
    expect(state && 'changed' in state ? state.changed : null).toBe(3)
  })

  it('sorts findings by their key and plans by harness and account', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        findings: [
          finding({ key: 'sentry/b:swallowed_error' }),
          finding({ key: 'sentry/a:path_traversal' }),
        ],
        plans: [
          plan({ harness: 'pi', account: null }),
          plan({ harness: 'claude-code', account: 'work@example.invalid' }),
        ],
      }),
      NOW,
    )
    expect(snapshot.findings.map((one) => one.key)).toEqual([
      'sentry/a:path_traversal',
      'sentry/b:swallowed_error',
    ])
    expect(snapshot.plans.map((one) => one.id)).toEqual(['claude-code/work@example.invalid', 'pi/'])
  })

  it('chooses the newest notes when it cannot carry them all', () => {
    const many = Array.from({ length: 5 }, (_, n) =>
      note({ at: `2026-10-0${n + 1}T00:00:00.000Z`, text: `note ${n}` }),
    )
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), notes: many }),
      NOW,
      {},
      budget({ notes: 2 }),
    )
    expect(snapshot.notes.map((one) => one.text?.words)).toEqual(['note 3', 'note 4'])
    expect(snapshot.pages.notes.omitted).toBe(3)
  })

  it('says a queue pause and a park apart, being two holds and one answer', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        queue: [
          {
            task: 'sentry/a-parked',
            project: 'sentry',
            state: { kind: 'paused', all: false, parked: true },
            order: null,
            waitsOn: [],
          },
          {
            task: 'sentry/b-paused',
            project: 'sentry',
            state: { kind: 'paused', all: true, parked: false },
            order: null,
            waitsOn: [],
          },
        ],
      }),
      NOW,
    )
    expect(snapshot.queue.map((one) => one.state)).toEqual([
      { kind: 'paused', all: false, parked: true },
      { kind: 'paused', all: true, parked: false },
    ])
  })

  it('leaves a cursor on a cut findings list, so the rest can be asked for', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        findings: [finding({ key: 'sentry/a' }), finding({ key: 'sentry/b' })],
      }),
      NOW,
      {},
      budget({ findings: 1, plans: 1 }),
    )
    expect(snapshot.findings.map((one) => one.key)).toEqual(['sentry/a'])
    expect(snapshot.pages.findings.next).toBe('sentry/a')
  })

  it('says a plan window has no reset time rather than placing it at the epoch', () => {
    const snapshot = snapshotOf(
      input({
        reach: reach(EVERY),
        plans: [
          {
            harness: 'pi',
            account: null,
            pays: 'plan',
            windows: [{ label: '7d', used: 10, resetsAt: 0 }],
            at: null,
            cannotTell: null,
          },
        ],
      }),
      NOW,
    )
    expect(snapshot.plans[0]?.windows[0]?.resetsAt).toBeNull()
    expect(snapshot.plans[0]?.at).toBeNull()
    expect(snapshot.plans[0]?.id).toBe('pi/')
  })
})

describe('a device that may read only some projects', () => {
  it('is told about those and about nothing else', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY, ['tade']) }), NOW)
    expect(snapshot.projects.map((one) => one.name)).toEqual(['tade'])
    expect(snapshot.tasks.map((one) => one.id)).toEqual(['tade/window'])
    expect(snapshot.queue).toEqual([])
    expect(snapshot.findings).toEqual([])
    expect(snapshot.pages.tasks.total).toBe(1)
  })

  it('does not count what it cannot see as omitted, which would say it exists', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY, ['tade']) }), NOW)
    expect(snapshot.pages.tasks.omitted).toBe(0)
    expect(snapshot.pages.findings.total).toBe(0)
  })

  it('keeps a note about a project it cannot read out of the notes as well', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY, ['tade']) }), NOW)
    expect(snapshot.notes).toEqual([])
    expect(snapshot.pages.notes.total).toBe(0)
  })

  it('keeps a note about everything, which belongs to no project', () => {
    const one = input({ reach: reach(EVERY, ['tade']) })
    const snapshot = snapshotOf({ ...one, notes: [{ ...one.notes[0]!, scope: null }] }, NOW)
    expect(snapshot.notes).toHaveLength(1)
  })
})

describe('the budget', () => {
  it('counts what it left out instead of going quiet about it', () => {
    const many = Array.from({ length: 9 }, (_, n) =>
      task({ id: `sentry/t${n}`, project: 'sentry' }),
    )
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), tasks: many, projects: [project()] }),
      NOW,
      {},
      budget({ tasks: 4, tasksPerProject: 9 }),
    )
    expect(snapshot.tasks).toHaveLength(4)
    expect(snapshot.pages.tasks).toEqual({
      total: 9,
      omitted: 5,
      next: 'sentry/t3',
      restarted: false,
    })
  })

  it('keeps one busy project from crowding out three quiet ones', () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, n) => task({ id: `sentry/t${n}`, project: 'sentry' })),
      task({ id: 'tade/window', project: 'tade' }),
    ]
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), tasks }),
      NOW,
      {},
      budget({ tasksPerProject: 2 }),
    )
    expect(snapshot.tasks.map((one) => one.id)).toEqual(['sentry/t0', 'sentry/t1', 'tade/window'])
    expect(snapshot.projects.find((one) => one.name === 'sentry')?.counts).toEqual({
      tasks: 8,
      shown: 2,
      wantsYou: 0,
      working: 8,
      queued: 0,
    })
  })

  it('counts the tasks it dropped for fairness among the ones it left out', () => {
    // The count has to be the real one. `pageOf` only ever sees what survived
    // the per-project cut, so taking its total would under-report by exactly
    // the number of tasks that were cut for fairness — and a page that says
    // "3 of 3" while six are missing is the failure the counts exist to stop.
    const tasks = Array.from({ length: 8 }, (_, n) =>
      task({ id: `sentry/t${n}`, project: 'sentry' }),
    )
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), tasks }),
      NOW,
      {},
      budget({ tasksPerProject: 2 }),
    )
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.pages.tasks).toMatchObject({ total: 8, omitted: 6 })
  })

  it('carries on from a cursor', () => {
    const many = Array.from({ length: 6 }, (_, n) =>
      task({ id: `sentry/t${n}`, project: 'sentry' }),
    )
    const snapshot = snapshotOf(
      input({ reach: reach(EVERY), tasks: many }),
      NOW,
      { tasks: 'sentry/t2' },
      budget({ tasks: 2 }),
    )
    expect(snapshot.tasks.map((one) => one.id)).toEqual(['sentry/t3', 'sentry/t4'])
    expect(snapshot.pages.tasks.next).toBe('sentry/t4')
  })

  it('says the list moved when a cursor names a row that has gone', () => {
    const page = pageOf(['a', 'b', 'c'], 2, (row) => row, 'gone')
    expect(page).toEqual({
      rows: ['a', 'b'],
      total: 3,
      omitted: 1,
      next: 'b',
      restarted: true,
    })
  })

  it('reaches the end with nothing to carry on from', () => {
    const page = pageOf(['a', 'b'], 5, (row) => row)
    expect(page).toEqual({ rows: ['a', 'b'], total: 2, omitted: 0, next: null, restarted: false })
  })

  it('cuts free text and says there is more, rather than writing an ellipsis', () => {
    expect(textOf('abcdef', 3)).toEqual({ words: 'abc', more: true })
    expect(textOf('abc', 3)).toEqual({ words: 'abc', more: false })
    expect(textOf('', 3)).toBeNull()
    expect(textOf(null, 3)).toBeNull()
  })
})
