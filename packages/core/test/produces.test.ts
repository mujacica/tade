import { describe, expect, it } from 'vitest'
import type { EventType, TadeEvent } from '../src/events.ts'
import { actedOnSays, producedClause, producedIn, producesProblem } from '../src/produces.ts'

let seq = 0
function event(
  type: EventType,
  task: string,
  detail: Record<string, unknown> = {},
  minute = 0,
): TadeEvent {
  seq++
  return {
    seq,
    ts: new Date(Date.UTC(2026, 8, 15, 9, minute)).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

describe('a path a task may produce', () => {
  it('takes an ordinary file in the repository', () => {
    expect(producesProblem('notes/scope-audit.md')).toBe(null)
    expect(producesProblem('AUDIT.md')).toBe(null)
  })

  it('refuses one under Tade’s own folder, because it goes when the task goes', () => {
    const said = producesProblem('.tade/audit.md')
    expect(said).toContain('git ignores')
    expect(said).toContain('removes with the task')
    // A folder that merely starts with the same letters is somebody's own.
    expect(producesProblem('.tadepole/audit.md')).toBe(null)
  })

  it('refuses one that is not inside the repository at all', () => {
    expect(producesProblem('/tmp/audit.md')).toContain('not in the repository')
    expect(producesProblem('~/audit.md')).toContain('not in the repository')
    expect(producesProblem('C:\\audit.md')).toContain('not in the repository')
    expect(producesProblem('../elsewhere/audit.md')).toContain('climbs out')
    expect(producesProblem('notes/../../out.md')).toContain('climbs out')
  })

  it('refuses nothing at all, which is the shape of a field left empty', () => {
    expect(producesProblem('   ')).toContain('name the file it writes')
  })
})

describe('documents finished tasks produced', () => {
  it('is the path and the summary off the line that says it finished', () => {
    const [one, ...rest] = producedIn([
      event('task_done', 'app/audit', {
        by: 'agent',
        summary: 'Four call sites take the token twice.',
        produces: 'notes/scope-audit.md',
      }),
    ])
    expect(rest).toEqual([])
    expect(one).toMatchObject({
      task: 'app/audit',
      path: 'notes/scope-audit.md',
      summary: 'Four call sites take the token twice.',
      missing: false,
      followed: [],
      reused: false,
    })
  })

  it('says nothing about a task that finished without naming one', () => {
    expect(
      producedIn([event('task_done', 'app/refunds', { by: 'agent', summary: 'done' })]),
    ).toEqual([])
  })

  it('counts work queued off it afterwards, and never a plan that named it before', () => {
    const [one] = producedIn([
      // A plan written before the research ran waits on it: that is the plan
      // waiting, not somebody deciding what the document turned out to say.
      event('task_created', 'app/planned-earlier', { after: ['app/audit'] }, 1),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 2),
      event('task_created', 'app/fix-scopes', { after: ['app/audit'] }, 3),
      event('task_created', 'app/unrelated', {}, 4),
    ])
    expect(one?.followed).toEqual(['app/fix-scopes'])
    expect(producedClause(one!)).toBe(
      'produced notes/audit.md, and app/fix-scopes was queued off it',
    )
  })

  it('counts its own agent being started again, which is the other thing to do about one', () => {
    const [one] = producedIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
      event('run_started', 'app/audit', {}, 2),
    ])
    expect(one?.reused).toBe(true)
    expect(producedClause(one!)).toBe(
      'produced notes/audit.md, and its own agent was started again',
    )
  })

  it('forgets a removed task, whose worktree no longer says where to look', () => {
    expect(
      producedIn([
        event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
        event('task_removed', 'app/audit', {}, 2),
      ]),
    ).toEqual([])
  })

  it('starts again when a task finishes a second time', () => {
    const [one] = producedIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 1),
      event('task_created', 'app/fix-scopes', { after: ['app/audit'] }, 2),
      event('run_started', 'app/audit', {}, 3),
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md' }, 4),
    ])
    expect(one).toMatchObject({ followed: [], reused: false })
  })

  it('leaves out what finished before the window asked about', () => {
    const events = [
      event('task_done', 'app/old', { by: 'agent', produces: 'notes/old.md' }, 0),
      event('task_done', 'app/new', { by: 'agent', produces: 'notes/new.md' }, 30),
    ]
    const since = Date.UTC(2026, 8, 15, 9, 15)
    expect(producedIn(events, { since }).map((one) => one.task)).toEqual(['app/new'])
  })

  it('says a task named a document and did not write one, rather than sending anybody to it', () => {
    const [one] = producedIn([
      event('task_done', 'app/audit', { by: 'agent', produces: 'notes/audit.md', missing: true }),
    ])
    expect(one?.missing).toBe(true)
    expect(producedClause(one!)).toBe('said it would produce notes/audit.md and did not write it')
  })
})

describe('what has been done about a document', () => {
  it('is nothing, until something is', () => {
    expect(actedOnSays({})).toBe('nothing has been done about it yet')
  })

  it('names every task queued off it', () => {
    expect(actedOnSays({ followed: ['app/one', 'app/two'] })).toBe(
      'app/one, app/two were queued off it',
    )
  })

  it('says both, where both happened', () => {
    expect(actedOnSays({ followed: ['app/one'], reused: true })).toBe(
      'app/one was queued off it, and its own agent was started again',
    )
  })
})
